/**
 * Automated Narrative Analysis Runner
 * 
 * Runs price-narrative analysis for all stocks and outputs results.
 * Called by GitHub Actions workflow.
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.split('=');
    if (key && value) {
      args[key.replace(/^--/, '')] = value;
    }
  });
  return args;
}

const args = parseArgs();
const TICKERS = args.tickers === 'all' 
  ? ['PME', 'XRO', 'CSL', 'WOW', 'WTC', 'DRO', 'GYG', 'MQG', 'GMG', 'WDS', 'SIG', 'FMG']
  : args.tickers.split(',').map(t => t.trim().toUpperCase());

const THRESHOLD = args.threshold || 'MODERATE';
const OUTPUT_FILE = args.output || 'data/narrative-analysis.json';

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║  CONTINUUM NARRATIVE FRAMEWORK — Automated Analysis           ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log('Configuration:');
console.log(`  Tickers: ${TICKERS.join(', ')}`);
console.log(`  Threshold: ${THRESHOLD}`);
console.log(`  Output: ${OUTPUT_FILE}\n`);

// Load engines
const { PriceNarrativeEngine } = require('./price-narrative-engine.js');
const { InstitutionalCommentaryEngine } = require('./institutional-commentary-engine.js');

// Load STOCK_DATA
const indexHtmlPath = path.join(__dirname, '..', 'index.html');
let STOCK_DATA = {};

try {
  // Extract STOCK_DATA from index.html
  const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
  
  // Find STOCK_DATA assignments
  const stockDataMatches = indexContent.match(/STOCK_DATA\.(\w+)\s*=\s*\{/g);
  if (stockDataMatches) {
    stockDataMatches.forEach(match => {
      const ticker = match.match(/STOCK_DATA\.(\w+)/)[1];
      // Extract the full object (this is a simplified extraction)
      const startIdx = indexContent.indexOf(match);
      let braceCount = 0;
      let endIdx = startIdx;
      let inString = false;
      let stringChar = null;
      
      for (let i = startIdx; i < indexContent.length; i++) {
        const char = indexContent[i];
        
        if (!inString && (char === '"' || char === "'" || char === '`')) {
          inString = true;
          stringChar = char;
        } else if (inString && char === stringChar && indexContent[i-1] !== '\\') {
          inString = false;
          stringChar = null;
        } else if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }
      }
      
      const objectStr = indexContent.substring(startIdx, endIdx);
      try {
        // Use Function constructor to safely evaluate the object
        const fn = new Function(`
          const STOCK_DATA = {};
          ${objectStr};
          return STOCK_DATA.${ticker};
        `);
        STOCK_DATA[ticker] = fn();
      } catch (e) {
        console.warn(`Could not parse STOCK_DATA.${ticker}:`, e.message);
      }
    });
  }
} catch (e) {
  console.error('Error loading STOCK_DATA:', e.message);
}

// Load live prices
let livePrices = { prices: {} };
try {
  livePrices = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'live-prices.json'), 'utf8'));
} catch (e) {
  console.warn('Could not load live prices, using defaults');
}

// Build price data helper
function buildPriceData(ticker, stockData) {
  const livePrice = livePrices.prices[ticker];
  const priceHistory = stockData.priceHistory || [];
  
  const currentPrice = livePrice?.p || stockData.price || priceHistory[priceHistory.length - 1] || 100;
  const previousPrice = livePrice?.pc || priceHistory[priceHistory.length - 2] || currentPrice;
  const priceAtReview = stockData.price || currentPrice;
  const peakPrice = Math.max(...priceHistory, currentPrice);
  const low52Week = Math.min(...priceHistory, currentPrice);
  const high52Week = peakPrice;
  
  const returns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    returns.push((priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1]);
  }
  
  let consecutiveDown = 0;
  for (let i = priceHistory.length - 1; i > 0; i--) {
    if (priceHistory[i] < priceHistory[i-1]) consecutiveDown++;
    else break;
  }
  
  return {
    currentPrice,
    previousPrice,
    priceAtReview,
    peakPrice,
    low52Week,
    high52Week,
    todayVolume: livePrice?.v || 1000000,
    avgVolume20d: livePrice?.v ? livePrice.v / 1.5 : 800000,
    historicalReturns: returns.length ? returns : [0, 0, 0, 0, 0],
    consecutiveDownDays: consecutiveDown
  };
}

// Severity threshold check
const SEVERITY_LEVELS = { 'NORMAL': 0, 'MODERATE': 1, 'HIGH': 2, 'CRITICAL': 3 };
const thresholdLevel = SEVERITY_LEVELS[THRESHOLD] || 1;

// Run analysis
const results = {};
const summary = {
  runAt: new Date().toISOString(),
  tickersAnalyzed: TICKERS.length,
  criticalDislocations: 0,
  highDislocations: 0,
  moderateDislocations: 0,
  normal: 0,
  errors: []
};

for (const ticker of TICKERS) {
  try {
    console.log(`\nAnalyzing ${ticker}...`);
    
    const stockData = STOCK_DATA[ticker];
    if (!stockData) {
      console.warn(`  ⚠️ No data found for ${ticker}`);
      summary.errors.push({ ticker, error: 'No data found' });
      continue;
    }
    
    const priceData = buildPriceData(ticker, stockData);
    
    console.log(`  Price: A$${priceData.currentPrice} | ` +
                `Change: ${((priceData.currentPrice - priceData.previousPrice) / priceData.previousPrice * 100).toFixed(2)}%`);
    
    // Run analysis
    const analysis = PriceNarrativeEngine.analyze(ticker, stockData, priceData);
    
    // Generate institutional commentary
    if (analysis.shouldUpdate || SEVERITY_LEVELS[analysis.dislocation.severity] >= thresholdLevel) {
      analysis.institutionalCommentary = InstitutionalCommentaryEngine.generateReport(
        ticker, stockData, priceData, analysis.weights, analysis.dislocation, analysis.inference
      );
    }
    
    results[ticker] = analysis;
    
    // Update summary
    switch (analysis.dislocation.severity) {
      case 'CRITICAL': summary.criticalDislocations++; break;
      case 'HIGH': summary.highDislocations++; break;
      case 'MODERATE': summary.moderateDislocations++; break;
      default: summary.normal++;
    }
    
    console.log(`  Severity: ${analysis.dislocation.severity} | ` +
                `Primary: ${analysis.inference.primaryHypothesis} | ` +
                `Max Gap: ${Math.max(...Object.values(analysis.weights).map(w => Math.abs(w.longTerm - w.shortTerm)))}pts`);
    
  } catch (e) {
    console.error(`  ❌ Error analyzing ${ticker}:`, e.message);
    summary.errors.push({ ticker, error: e.message });
  }
}

// Output results
const output = {
  summary,
  results,
  generatedAt: new Date().toISOString()
};

// Ensure output directory exists
const outputDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write output
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

console.log('\n' + '═'.repeat(64));
console.log('ANALYSIS COMPLETE');
console.log('═'.repeat(64));
console.log(`Total analyzed: ${summary.tickersAnalyzed}`);
console.log(`Critical: ${summary.criticalDislocations} 🔴`);
console.log(`High: ${summary.highDislocations} 🟠`);
console.log(`Moderate: ${summary.moderateDislocations} 🟡`);
console.log(`Normal: ${summary.normal} 🟢`);
console.log(`Errors: ${summary.errors.length}`);
console.log(`\nOutput written to: ${OUTPUT_FILE}`);

// Exit with error code if critical dislocations found (for CI/CD)
if (summary.criticalDislocations > 0) {
  console.log('\n⚠️ Critical dislocations detected — manual review recommended');
  process.exit(1);
}
