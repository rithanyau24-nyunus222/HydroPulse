# HydroPulse

STP Filtered Water Quality Monitor and Groundwater Recharge Assessment System

Live Website: https://rithanyau24-nyunus222.github.io/HydroPulse/

HydroPulse is an intelligent, real-time IoT Telemetry, SCADA Decision Control, and Compliance Monitoring System. It continuously evaluates treated effluent from Sewage Treatment Plants (STP) against statutory Central Pollution Control Board (CPCB) and State Pollution Control Board (TNPCB) aquifer recharge norms.

The system dynamically computes the Water Quality Index (WQI) and drives an automated fail-safe motorized dual-way valve:
- Safe Effluent (APPROVED): Diverted into deep recharge infiltration wells for subterranean aquifer replenishment.
- Breach / Non-Compliant (PROHIBITED): Instant motorized valve lockout and diversion into a secondary retention or polishing lagoon.

## Repository Contents

- index.html: Single-file dashboard with real-time Supabase integration, dynamic WQI engine, metric cards with safety margins, inline SVG P&ID SCADA diagram, and administrative drawer.
- schema.sql: Production PostgreSQL schema with automated server-side evaluation triggers, incident tracking triggers, security_invoker views, and Row Level Security (RLS).
- simulate.js: Standalone Node 18+ telemetry generator supporting demo backfill, live streaming, stochastic Box-Muller noise, and valve event logging.
- device.ino: Production ESP32 firmware with averaged ADC multi-sampling, calibration parameters, local threshold checks, and fail-safe relay lockout.

## Setup Instructions

### 1. Database Setup (Supabase)
1. Create a free project at https://supabase.com
2. Open the SQL Editor in your Supabase dashboard.
3. Paste the contents of schema.sql and execute the script.

### 2. Live Dashboard
- Visit the hosted GitHub Pages URL: https://rithanyau24-nyunus222.github.io/HydroPulse/
- Alternatively, clone this repository and open index.html directly in any modern web browser.
- Open the Admin drawer to click Import 5 Core Limits to establish statutory CPCB standards.

### 3. Telemetry Simulation
Run the simulator using Node.js 18 or later:

```bash
export SUPABASE_URL="https://kfncoyavignqtwudkeff.supabase.co"
export SUPABASE_ANON_KEY="<your-supabase-anon-key>"
node simulate.js demo
```

On Windows PowerShell:
```powershell
$env:SUPABASE_URL="https://kfncoyavignqtwudkeff.supabase.co"
$env:SUPABASE_ANON_KEY="<your-supabase-anon-key>"
node simulate.js demo
```

Simulation commands:
- node simulate.js demo: Backfills 24h of telemetry and starts a 5-second streaming loop.
- node simulate.js live: Starts streaming live telemetry immediately without backfilling.
- node simulate.js exceed:Turbidity: Simulates a 130 percent threshold breach, locking the valve.
- node simulate.js fix:Turbidity: Restores parameter compliance and re-opens the valve.

### 4. Hardware Firmware (ESP32)
1. Open device.ino in Arduino IDE.
2. Select your ESP32 board.
3. Configure your Wi-Fi SSID and Password in the configuration constants.
4. Upload to your ESP32 microcontroller.
