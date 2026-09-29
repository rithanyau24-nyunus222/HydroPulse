const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required.");
  process.exit(1);
}

const headers = {
  "apikey": SUPABASE_ANON_KEY,
  "Authorization": "Bearer " + SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
  "Prefer": "return=minimal"
};

function boxMuller() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function computeNormalValue(s, stepIndex) {
  const hasMin = s.min_value !== null && s.min_value !== undefined;
  const hasMax = s.max_value !== null && s.max_value !== undefined;

  let target = 700;
  if (hasMin && hasMax) {
    target = (Number(s.min_value) + Number(s.max_value)) / 2;
  } else if (hasMax) {
    target = 0.60 * Number(s.max_value);
  } else if (hasMin) {
    target = 1.40 * Number(s.min_value);
  }

  const wave = Math.sin(stepIndex * 0.1) * 0.05;
  const noise = boxMuller() * 0.02;
  let val = target * (1 + wave + noise);

  val = Math.max(target * 0.92, Math.min(target * 1.08, val));

  if (hasMin && val <= Number(s.min_value)) {
    val = Number(s.min_value) + (target - Number(s.min_value)) * 0.1;
  }
  if (hasMax && val >= Number(s.max_value)) {
    val = Number(s.max_value) - (Number(s.max_value) - target) * 0.1;
  }

  return Math.round(val * 100) / 100;
}

function computeExceedValue(s) {
  if (s.max_value !== null && s.max_value !== undefined) {
    return Math.round(1.30 * Number(s.max_value) * 100) / 100;
  }
  if (s.min_value !== null && s.min_value !== undefined) {
    return Math.round(0.70 * Number(s.min_value) * 100) / 100;
  }
  return 910;
}

async function postBatch(rows) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/readings", {
    method: "POST",
    headers: headers,
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    console.error("HTTP " + res.status + " on batch insert");
  }
  return res.ok;
}

async function postSingleReading(param, val) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/readings", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      parameter: param,
      value: val,
      source: "simulator",
      recorded_at: new Date().toISOString()
    })
  });
  return res.ok;
}

async function postValveEvent(state, reason) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/valve_events", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      state: state,
      reason: reason,
      source: "simulator",
      recorded_at: new Date().toISOString()
    })
  });
  return res.ok;
}

async function main() {
  const args = process.argv.slice(2);
  const forceBackfill = args.includes("--force");
  const cleanArgs = args.filter(a => a !== "--force");
  const firstArg = cleanArgs[0] || "demo";

  let mode = "demo";
  let modeParam = null;

  if (firstArg === "demo") {
    mode = "demo";
  } else if (firstArg === "live") {
    mode = "live";
  } else if (firstArg.startsWith("exceed:")) {
    mode = "exceed";
    modeParam = firstArg.slice(7);
  } else if (firstArg.startsWith("fix:")) {
    mode = "fix";
    modeParam = firstArg.slice(4);
  } else {
    console.error("Unknown mode: " + firstArg);
    process.exit(1);
  }

  const stdRes = await fetch(SUPABASE_URL + "/rest/v1/standards?select=*&order=sort_order.asc", {
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + SUPABASE_ANON_KEY
    }
  });

  if (!stdRes.ok) {
    console.error("HTTP " + stdRes.status + " failed to fetch standards");
    process.exit(1);
  }

  const standards = await stdRes.json();

  if (!Array.isArray(standards) || standards.length === 0) {
    console.error("Standards table is empty. Configure standards before running simulation.");
    process.exit(1);
  }

  if (mode === "fix") {
    const target = standards.find(s => s.parameter.toLowerCase() === modeParam.toLowerCase());
    if (!target) {
      console.error("Parameter not found: " + modeParam);
      process.exit(1);
    }
    const val = computeNormalValue(target, 0);
    const ok = await postSingleReading(target.parameter, val);
    if (ok) {
      await postValveEvent("open", "Parameter recovered: " + target.parameter);
      console.log("Fixed " + target.parameter + " with value " + val);
    }
    process.exit(ok ? 0 : 1);
  }

  if (mode === "exceed") {
    const target = standards.find(s => s.parameter.toLowerCase() === modeParam.toLowerCase());
    if (!target) {
      console.error("Parameter not found: " + modeParam);
      process.exit(1);
    }
    const exceedVal = computeExceedValue(target);
    const ok = await postSingleReading(target.parameter, exceedVal);
    if (ok) {
      await postValveEvent("locked", "Parameter breach: " + target.parameter + " = " + exceedVal);
      console.log("Exceed reading posted: " + target.parameter + " = " + exceedVal);
    }
    process.exit(ok ? 0 : 1);
  }

  if (mode === "demo") {
    let shouldBackfill = forceBackfill;

    if (!shouldBackfill) {
      const checkRes = await fetch(SUPABASE_URL + "/rest/v1/readings?select=id&source=eq.simulator&limit=1", {
        headers: headers
      });
      if (checkRes.ok) {
        const existing = await checkRes.json();
        if (!Array.isArray(existing) || existing.length === 0) {
          shouldBackfill = true;
        }
      }
    }

    if (shouldBackfill) {
      console.log("Backfilling 24h telemetry...");
      const now = Date.now();
      const backfillRows = [];

      const liveStandards = standards.filter(s => s.measurement === "live");
      for (const s of liveStandards) {
        for (let i = 0; i < 144; i++) {
          const ts = new Date(now - (144 - i) * 10 * 60 * 1000).toISOString();
          const val = computeNormalValue(s, i);
          backfillRows.push({
            parameter: s.parameter,
            value: val,
            source: "simulator",
            recorded_at: ts
          });
        }
      }

      const labStandards = standards.filter(s => s.measurement === "lab");
      for (const s of labStandards) {
        for (let d = 5; d >= 0; d--) {
          const ts = new Date(now - d * 24 * 60 * 60 * 1000).toISOString();
          const val = computeNormalValue(s, 5 - d);
          backfillRows.push({
            parameter: s.parameter,
            value: val,
            source: "simulator",
            recorded_at: ts
          });
        }
      }

      backfillRows.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

      for (let i = 0; i < backfillRows.length; i += 500) {
        const chunk = backfillRows.slice(i, i + 500);
        await postBatch(chunk);
      }
      console.log("Backfill complete (" + backfillRows.length + " rows).");
    }
  }

  let currentValveState = "open";
  await postValveEvent(currentValveState, "Simulator started in normal mode");

  const liveStandards = standards.filter(s => s.measurement === "live");
  const labStandards = standards.filter(s => s.measurement === "lab");

  let step = 0;

  async function cycle() {
    step++;
    const summary = [];
    let hasFail = false;

    for (const s of liveStandards) {
      const val = computeNormalValue(s, step);
      summary.push(s.parameter + ": " + val);

      if (s.min_value !== null && val < Number(s.min_value)) hasFail = true;
      if (s.max_value !== null && val > Number(s.max_value)) hasFail = true;

      await postSingleReading(s.parameter, val);
    }

    if (step % 60 === 1) {
      for (const ls of labStandards) {
        const labVal = computeNormalValue(ls, step);
        summary.push(ls.parameter + "(lab): " + labVal);
        await postSingleReading(ls.parameter, labVal);
      }
    }

    const nextValveState = hasFail ? "locked" : "open";
    if (nextValveState !== currentValveState) {
      currentValveState = nextValveState;
      await postValveEvent(currentValveState, hasFail ? "Automatic trip on live reading" : "All live standards compliant");
      console.log("Valve state changed to: " + currentValveState);
    }

    console.log(new Date().toLocaleTimeString() + " - " + summary.join(", "));
  }

  await cycle();
  setInterval(cycle, 5000);
}

main();
