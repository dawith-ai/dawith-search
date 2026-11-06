const { performance } = require('perf_hooks');
const { NativeSearchAdapter } = require('../src/engine/native-search');

const query = process.argv.slice(2).join(' ').trim() || 'report';
const iterations = Math.max(5, Number(process.env.DAWITH_BENCHMARK_ITERATIONS) || 20);
const adapter = new NativeSearchAdapter();

async function measure() {
  const samples = [];
  let last = null;
  for (let index = 0; index < iterations + 2; index += 1) {
    const started = performance.now();
    last = await adapter.search(query, { limit: 100 });
    const elapsed = performance.now() - started;
    if (index >= 2) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  const percentile = ratio => samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))];
  return {
    backend: last?.backend || 'local',
    matches: last?.records?.length || 0,
    minMs: samples[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: samples[samples.length - 1]
  };
}

measure().then(result => {
  console.log(JSON.stringify({ query, iterations, ...result }, null, 2));
  if (!['goz', 'everything', 'spotlight'].includes(result.backend)) {
    console.error('Native backend was not available; this run measured the fallback path.');
  }
}).catch(error => {
  console.error(`Native search benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
