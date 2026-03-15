# 🌍 PrithviNet: Intelligent Environmental Compliance Monitoring

> **Made by Priority Thread**

## 📖 Overview
Monitoring environmental compliance across vast industrial and civic zones has historically been a challenge. **PrithviNet** is a real-time, IoT-driven platform for tracking, forecasting, and enforcing environmental standards for air, water, and noise. It moves compliance from a reactive, paper-heavy process into a proactive, data-driven ecosystem.

By integrating simulated IoT sensor feeds, a rules-based Compliance Engine, and a powerful AI integration (powered by Google Gemini), PrithviNet gives regulatory authorities and citizens a transparent, real-time snapshot of the ecological health of a region.

---

## ✨ Core Features

1. **🗺️ Real-Time Monitoring & Telemetry Dashboard (`index.html`)**
   An intuitive, interactive map built with Leaflet.js that displays continuous, live data via Server-Sent Events (SSE). Hover over an area to see real-time AQI, water pollution levels, and noise readings.
   
2. **⚖️ Automated Compliance Engine (`server/compliance-engine.js`)**
   Instead of manual log checks, the platform automatically cross-references all incoming telemetry data against legal regulatory thresholds (e.g., standard particulate matter limits). Violations trigger immediate alerts to the civic portal.

3. **🚨 Compliance & Civic Tracker (`civic.html`)**
   A dedicated interface to view, manage, and act upon generated compliance alerts. Features filtering, verifiable data logs, and status tracking (e.g., Open, Escalated, Resolved).

4. **🤖 PrithviNet Copilot: Context-Aware AI (`copilot.html`)**
   Powered by Google Gemini 2.0. This natural language chatbot connects directly to the platform's database. Authorities can ask questions like *"Which industries in Chhattisgarh breached SO2 limits today?"* or request 24-hour predictive pollution forecasts.

5. **⚙️ Master Entity Management (`entities.html`)**
   Provides strict role-based access control (RBAC). Administrators can easily register new industrial entities, assign sensors, and manage geographic boundaries.

---

## 🏗️ System Architecture

- **Backend:** Node.js, Express.js
- **Database:** SQLite (`prithvinet.db`)
- **Frontend UI:** HTML5, CSS3, Vanilla JavaScript, Leaflet.js
- **AI Integration:** Google Gemini REST API
- **Live Streams:** SSE (Server-Sent Events)
- **Data Emulation:** Custom Node.js IoT Data Simulator

---

## 📂 Project Structure

```text
PrithviNet/
├── README.md               # You are here!
├── architecture.md         # Detailed Mermaid.js architectural diagrams
├── index.html              # Main real-time Map Dashboard UI
├── civic.html              # Compliance Alerts UI
├── copilot.html            # AI Chatbot UI
├── entities.html           # Administrator Portal UI
├── *.geojson               # Map mapping boundaries (Chhattisgarh, Delhi)
├── app.js / civic.js       # Frontend controllers for handling logic and SSE
└── server/
    ├── package.json        # Node.js dependencies
    ├── index.js            # Main Express Server Entry Point
    ├── authz.js            # Role-Based Access Control integration
    ├── db.js               # SQLite Database connection mapping
    ├── simulator.js        # IoT Simulator generating continuous mock data
    ├── compliance-engine.js# Telemetry validation & rules engine
    └── routes/             # Isolated Express routing
        ├── api.js          # Main API endpoints
        ├── compliance.js   # Alerts & logs APIs
        ├── copilot.js      # Gemini AI / prompt-engineering API
        ├── entities.js     # Management APIs
        └── forecast.js     # Predictive analytic modules
```

---

## 🚀 Installation & Setup

### Prerequisites
- Node.js (v16.x or newer)
- npm (Node Package Manager)
- A stable internet connection (for Gemini API capabilities and map tiles mapping)

### 1. Clone & Navigate
```bash
git clone https://github.com/Priyanshu124-tech/PrithviNet.git
cd PrithviNet
```

### 2. Enter backend and install Dependencies
```bash
cd server
npm install
```

### 3. Start the Platform
```bash
npm start
```
*Note: This command runs the `server/index.js` file, starting the Express backend on `http://localhost:3000` and automatically executing `simulator.js` to begin generating continuous test data.*

### 4. Open Application
Once the server is running, simply access:
- **Map Dashboard (Main):** [http://localhost:3000/index.html](http://localhost:3000/index.html)
- **Compliance UI:** [http://localhost:3000/civic.html](http://localhost:3000/civic.html)
- **Copilot UI:** [http://localhost:3000/copilot.html](http://localhost:3000/copilot.html)

*(Or just open the `.html` files directly via Live Server if your static paths are configured!)*

---

## 🛠️ Modifying the AI (Gemini)
If you wish to manage the Gemini AI capabilities via your own key:
1. Open `server/routes/copilot.js`
2. Locate the variable: `const GEMINI_KEY = 'YOUR_API_KEY_HERE';`
3. Replace the string with your own Gemini API key obtained from [Google AI Studio](https://aistudio.google.com/).

---

## 🛡️ License & Acknowledgements
**Made by Priority Thread** for environmental compliance.
*Note: GeoJSON map attributes correspond to civic and industrial regions used purely for UI simulation and demonstration.*
