const SUPABASE_URL = "https://kfncoyavignqtwudkeff.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmbmNveWF2aWducXR3dWRrZWZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NTUwODYsImV4cCI6MjEwNjIzMTA4Nn0.bFM2j0ldqn7lYTEag0Q5xd_PRU4Ps6EyZ1FMhxq1rsE";

const DEMO_MONITOR_ONLY_BASE = 700;

async function apiRequest(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
    ...options.headers
  };
  return fetch(url, { ...options, headers });
}

async function fetchStandards() {
  const res = await apiRequest("/standards?select=*&order=sort_order");
  if (!res.ok) {
    throw new Error(`Failed to fetch standards: HTTP ${res.status}`);
  }
  return res.json();
}

async function checkExistingSimulatorRows() {
  const res = await apiRequest("/readings?select=id&source=eq.simulator&limit=1", {
    headers: { "Prefer": "count=exact" }
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

async function postReadingsBatch(readings) {
  if (readings.length === 0) return;
  const res = await apiRequest("/readings", {
    method: "POST",
    body: JSON.stringify(readings)
  });
  if (!res.ok) {
    const errText = await res.text();
    console.log(`Batch insert failure: HTTP ${res.status} - ${errText}`);
  } else {
    console.log(`Posted batch of ${readings.length} readings`);
  }
}

async function postSingleReading(parameter, value) {
  const body = [{
    parameter,
    value,
    source: "simulator",
    recorded_at: new Date().toISOString()
  }];
  const res = await apiRequest("/readings", {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    console.log(`${parameter}: ${value} - Failure HTTP ${res.status} - ${errText}`);
  } else {
    console.log(`${parameter}: ${value}`);
  }
}

function computeTargetValue(standard) {
  const hasMin = standard.min_value !== null && standard.min_value !== undefined;
  const hasMax = standard.max_value !== null && standard.max_value !== undefined;

  if (hasMin && hasMax) {
    return (Number(standard.min_value) + Number(standard.max_value)) / 2;
  }
  if (hasMax) {
    return Number(standard.max_value) * 0.6;
  }
  if (hasMin) {
    return Number(standard.min_value) * 1.4;
  }
  return DEMO_MONITOR_ONLY_BASE;
}

function calculateNormalValue(standard, step) {
  const target = computeTargetValue(standard);
  const hasMin = standard.min_value !== null && standard.min_value !== undefined;
  const hasMax = standard.max_value !== null && standard.max_value !== undefined;

  if (!hasMin && !hasMax) {
    const drift = Math.sin(step * 0.1) * 0.05;
    return Math.round((target * (1 + drift)) * 100) / 100;
  }

  const wave = Math.sin(step * 0.15) * 0.05;
  const noise = (Math.random() - 0.5) * 0.03;
  let val = target * (1 + wave + noise);

  if (hasMin && val < Number(standard.min_value)) {
    val = Number(standard.min_value) + 0.1;
  }
  if (hasMax && val > Number(standard.max_value)) {
    val = Number(standard.max_value) - 0.1;
  }

  return Math.round(val * 100) / 100;
}

async function backfillHistory(standards) {
  console.log("Backfilling historical readings...");
  const readings = [];
  const now = Date.now();

  const liveStandards = standards.filter(s => s.measurement === "live");
  for (let i = 143; i >= 0; i--) {
    const timestamp = new Date(now - i * 10 * 60 * 1000).toISOString();
    for (const s of liveStandards) {
      readings.push({
        parameter: s.parameter,
        value: calculateNormalValue(s, 144 - i),
        source: "simulator",
        recorded_at: timestamp
      });
    }
  }

  const labStandards = standards.filter(s => s.measurement === "lab" && (s.min_value !== null || s.max_value !== null));
  for (let d = 5; d >= 0; d--) {
    const timestamp = new Date(now - d * 24 * 60 * 60 * 1000).toISOString();
    for (const s of labStandards) {
      readings.push({
        parameter: s.parameter,
        value: calculateNormalValue(s, 10 + d),
        source: "simulator",
        recorded_at: timestamp
      });
    }
  }

  const batchSize = 500;
  for (let i = 0; i < readings.length; i += batchSize) {
    const batch = readings.slice(i, i + batchSize);
    await postReadingsBatch(batch);
  }
  console.log("Historical backfill completed");
}

async function runLiveLoop(standards, overrides = {}) {
  let step = 0;
  const liveStandards = standards.filter(s => s.measurement === "live");

  const tick = async () => {
    step++;
    const nowIso = new Date().toISOString();
    const batch = [];

    for (const s of liveStandards) {
      let val;
      if (overrides[s.parameter]) {
        val = overrides[s.parameter](step);
      } else {
        val = calculateNormalValue(s, step);
      }
      batch.push({
        parameter: s.parameter,
        value: val,
        source: "simulator",
        recorded_at: nowIso
      });
    }

    const res = await apiRequest("/readings", {
      method: "POST",
      body: JSON.stringify(batch)
    });

    if (res.ok) {
      const summary = batch.map(b => `${b.parameter}: ${b.value}`).join(", ");
      console.log(`Live cycle ${step}: ${summary}`);
    } else {
      console.log(`Live cycle ${step} failed with HTTP ${res.status}`);
    }
  };

  await tick();
  setInterval(tick, 5000);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "demo";
  const force = args.includes("--force");

  let standards;
  try {
    standards = await fetchStandards();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (mode === "demo") {
    const exists = await checkExistingSimulatorRows();
    if (!exists || force) {
      await backfillHistory(standards);
    } else {
      console.log("Existing simulator data found; skipping backfill (use --force to overwrite)");
    }
    await runLiveLoop(standards);
  } else if (mode === "live") {
    await runLiveLoop(standards);
  } else if (mode.startsWith("exceed:")) {
    const paramName = mode.slice(7);
    const standard = standards.find(s => s.parameter.toLowerCase() === paramName.toLowerCase());
    if (!standard) {
      console.error(`Error: Parameter "${paramName}" not found in standards table.`);
      process.exit(1);
    }

    const hasMax = standard.max_value !== null && standard.max_value !== undefined;
    const hasMin = standard.min_value !== null && standard.min_value !== undefined;
    let targetExceed;
    if (hasMax) {
      targetExceed = Number(standard.max_value) * 1.3;
    } else if (hasMin) {
      targetExceed = Number(standard.min_value) * 0.7;
    } else {
      console.error(`Error: Parameter "${paramName}" has no limits configured to exceed.`);
      process.exit(1);
    }
    targetExceed = Math.round(targetExceed * 100) / 100;

    if (standard.measurement === "lab") {
      await postSingleReading(standard.parameter, targetExceed);
      process.exit(0);
    } else {
      console.log(`Ramping ${standard.parameter} to out-of-limit value ${targetExceed}`);
      const baseVal = computeTargetValue(standard);
      const overrides = {
        [standard.parameter]: (step) => {
          const progress = Math.min(1, step / 6);
          const current = baseVal + (targetExceed - baseVal) * progress;
          return Math.round(current * 100) / 100;
        }
      };
      await runLiveLoop(standards, overrides);
    }
  } else if (mode.startsWith("fix:")) {
    const paramName = mode.slice(4);
    const standard = standards.find(s => s.parameter.toLowerCase() === paramName.toLowerCase());
    if (!standard) {
      console.error(`Error: Parameter "${paramName}" not found in standards table.`);
      process.exit(1);
    }
    const safeVal = Math.round(computeTargetValue(standard) * 100) / 100;
    await postSingleReading(standard.parameter, safeVal);
    process.exit(0);
  } else {
    console.error(`Unknown mode: ${mode}`);
    console.error("Usage: node simulate.js [demo|live|exceed:<Param>|fix:<Param>] [--force]");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
