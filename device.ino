#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SUPABASE_HOST = "kfncoyavignqtwudkeff.supabase.co";
const char* SUPABASE_URL = "https://kfncoyavignqtwudkeff.supabase.co";
const char* SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmbmNveWF2aWducXR3dWRrZWZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NTUwODYsImV4cCI6MjEwNjIzMTA4Nn0.bFM2j0ldqn7lYTEag0Q5xd_PRU4Ps6EyZ1FMhxq1rsE";

const int PIN_TURBIDITY = 34;
const int PIN_PH = 35;
const int PIN_CONDUCTIVITY = 32;
const int PIN_RELAY = 26;

struct CalibrationConfig {
  float turbidity_offset_voltage;
  float turbidity_ntu_per_volt;
  float ph_voltage_neutral_7;
  float ph_volts_per_ph_unit;
  float ec_analog_reference_voltage;
  float ec_cell_constant_k;
};

CalibrationConfig calibration = {
  0.0f,
  1.0f,
  2.5f,
  0.18f,
  3.3f,
  1.0f
};

struct StandardLimit {
  String parameter;
  float min_value;
  float max_value;
  bool has_min;
  bool has_max;
};

StandardLimit standards[8];
int standardsCount = 0;

unsigned long lastTelemetryTime = 0;
unsigned long lastStandardsPollTime = 0;
unsigned long lastAssessmentPollTime = 0;
unsigned long retryBackoffMs = 1000;

bool relayOpen = false;
String lastAssessmentOverall = "unconfigured";
unsigned long lastValidAssessmentTime = 0;

WiFiClientSecure secureClient;

void lockRelay(const String& reason);
void openRelay();
void postValveEvent(const String& state, const String& reason);

float readAveragedAnalog(int pin, int samples) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (float)sum / (float)samples;
}

float calculateVoltage(float rawAdc) {
  return (rawAdc / 4095.0f) * 3.3f;
}

float measureTurbidity() {
  float raw = readAveragedAnalog(PIN_TURBIDITY, 20);
  float volts = calculateVoltage(raw);
  float ntu = (volts - calibration.turbidity_offset_voltage) * calibration.turbidity_ntu_per_volt;
  return max(0.0f, ntu);
}

float measurePh() {
  float raw = readAveragedAnalog(PIN_PH, 20);
  float volts = calculateVoltage(raw);
  float ph = 7.0f + ((calibration.ph_voltage_neutral_7 - volts) / calibration.ph_volts_per_ph_unit);
  return max(0.0f, min(14.0f, ph));
}

float measureConductivity() {
  float raw = readAveragedAnalog(PIN_CONDUCTIVITY, 20);
  float volts = calculateVoltage(raw);
  float ec = (volts / calibration.ec_analog_reference_voltage) * 1000.0f * calibration.ec_cell_constant_k;
  return max(0.0f, ec);
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 15000) {
    delay(500);
  }

  if (WiFi.status() != WL_CONNECTED) {
    lockRelay("Wi-Fi connection lost");
  }
}

bool postReading(const String& param, float val) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient https;
  String url = String(SUPABASE_URL) + "/rest/v1/readings";

  if (!https.begin(secureClient, url)) return false;

  https.addHeader("Content-Type", "application/json");
  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  https.addHeader("Prefer", "return=minimal");

  String payload = "{\"parameter\":\"" + param + "\",\"value\":" + String(val, 2) + ",\"source\":\"sensor\"}";
  int code = https.POST(payload);
  https.end();

  return (code >= 200 && code < 300);
}

void postValveEvent(const String& state, const String& reason) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient https;
  String url = String(SUPABASE_URL) + "/rest/v1/valve_events";

  if (!https.begin(secureClient, url)) return;

  https.addHeader("Content-Type", "application/json");
  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  https.addHeader("Prefer", "return=minimal");

  String payload = "{\"state\":\"" + state + "\",\"reason\":\"" + reason + "\",\"source\":\"device\"}";
  https.POST(payload);
  https.end();
}

void fetchStandards() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient https;
  String url = String(SUPABASE_URL) + "/rest/v1/standards?measurement=eq.live&select=parameter,min_value,max_value";

  if (!https.begin(secureClient, url)) return;

  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  int code = https.GET();
  if (code == 200) {
    String resp = https.getString();
    standardsCount = 0;

    int idx = 0;
    while ((idx = resp.indexOf("{\"parameter\":\"", idx)) != -1 && standardsCount < 8) {
      idx += 14;
      int endP = resp.indexOf("\"", idx);
      if (endP == -1) break;
      String p = resp.substring(idx, endP);

      float mn = 0.0f;
      bool hasMn = false;
      int mnIdx = resp.indexOf("\"min_value\":", endP);
      if (mnIdx != -1 && mnIdx < resp.indexOf("}", endP)) {
        mnIdx += 12;
        if (resp.substring(mnIdx, mnIdx + 4) != "null") {
          mn = resp.substring(mnIdx, resp.indexOf(",", mnIdx)).toFloat();
          hasMn = true;
        }
      }

      float mx = 0.0f;
      bool hasMx = false;
      int mxIdx = resp.indexOf("\"max_value\":", endP);
      if (mxIdx != -1 && mxIdx < resp.indexOf("}", endP)) {
        mxIdx += 12;
        int nextEnd = resp.indexOf("}", mxIdx);
        int nextComma = resp.indexOf(",", mxIdx);
        int valEnd = (nextComma != -1 && nextComma < nextEnd) ? nextComma : nextEnd;
        if (resp.substring(mxIdx, mxIdx + 4) != "null") {
          mx = resp.substring(mxIdx, valEnd).toFloat();
          hasMx = true;
        }
      }

      standards[standardsCount].parameter = p;
      standards[standardsCount].min_value = mn;
      standards[standardsCount].max_value = mx;
      standards[standardsCount].has_min = hasMn;
      standards[standardsCount].has_max = hasMx;
      standardsCount++;
    }
  }
  https.end();
}

void pollAssessment() {
  if (WiFi.status() != WL_CONNECTED) {
    lockRelay("Wi-Fi offline during assessment poll");
    return;
  }

  HTTPClient https;
  String url = String(SUPABASE_URL) + "/rest/v1/assessment?limit=1";

  if (!https.begin(secureClient, url)) {
    lockRelay("HTTPS client failed for assessment");
    return;
  }

  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  int code = https.GET();
  if (code == 200) {
    String resp = https.getString();
    int pos = resp.indexOf("\"overall\":\"");
    if (pos != -1) {
      pos += 11;
      int endPos = resp.indexOf("\"", pos);
      if (endPos != -1) {
        lastAssessmentOverall = resp.substring(pos, endPos);
        lastValidAssessmentTime = millis();
      }
    }
  } else {
    lockRelay("Assessment fetch failed HTTP " + String(code));
  }
  https.end();
}

void checkLimitsAndActuate(float turb, float ph, float ec) {
  bool localBreach = false;
  String breachReason = "";

  for (int i = 0; i < standardsCount; i++) {
    float val = 0.0f;
    if (standards[i].parameter.equalsIgnoreCase("turbidity")) val = turb;
    else if (standards[i].parameter.equalsIgnoreCase("ph")) val = ph;
    else if (standards[i].parameter.equalsIgnoreCase("tds") || standards[i].parameter.equalsIgnoreCase("ec")) val = ec;
    else continue;

    if (standards[i].has_min && val < standards[i].min_value) {
      localBreach = true;
      breachReason = "Local breach: " + standards[i].parameter + " below minimum";
      break;
    }
    if (standards[i].has_max && val > standards[i].max_value) {
      localBreach = true;
      breachReason = "Local breach: " + standards[i].parameter + " above maximum";
      break;
    }
  }

  if (localBreach) {
    lockRelay(breachReason);
    return;
  }

  bool assessmentFresh = (millis() - lastValidAssessmentTime) < 30000;
  if (lastAssessmentOverall == "pass" && assessmentFresh) {
    openRelay();
  } else {
    lockRelay("Assessment status is " + lastAssessmentOverall);
  }
}

void lockRelay(const String& reason) {
  if (relayOpen) {
    digitalWrite(PIN_RELAY, LOW);
    relayOpen = false;
    postValveEvent("locked", reason);
  } else {
    digitalWrite(PIN_RELAY, LOW);
  }
}

void openRelay() {
  if (!relayOpen) {
    digitalWrite(PIN_RELAY, HIGH);
    relayOpen = true;
    postValveEvent("open", "All parameters verified safe for recharge");
  }
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, LOW);
  relayOpen = false;

  pinMode(PIN_TURBIDITY, INPUT);
  pinMode(PIN_PH, INPUT);
  pinMode(PIN_CONDUCTIVITY, INPUT);

  secureClient.setInsecure();

  connectWifi();
  fetchStandards();
  pollAssessment();
}

void loop() {
  connectWifi();

  unsigned long now = millis();

  if (now - lastStandardsPollTime > 60000) {
    lastStandardsPollTime = now;
    fetchStandards();
  }

  if (now - lastAssessmentPollTime > 10000) {
    lastAssessmentPollTime = now;
    pollAssessment();
  }

  float turb = measureTurbidity();
  float ph = measurePh();
  float ec = measureConductivity();

  checkLimitsAndActuate(turb, ph, ec);

  if (now - lastTelemetryTime > 10000) {
    lastTelemetryTime = now;
    bool ok1 = postReading("Turbidity", turb);
    bool ok2 = postReading("pH", ph);
    bool ok3 = postReading("TDS", ec);

    if (ok1 && ok2 && ok3) {
      retryBackoffMs = 1000;
    } else {
      retryBackoffMs = min(retryBackoffMs * 2, 60000UL);
    }
  }

  delay(100);
}
