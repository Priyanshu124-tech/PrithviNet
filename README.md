# PrithviNet: Intelligent Environmental Compliance Monitoring

**Made by Priority Thread**
*(Or modified as per "Priority Thread")*

## Overview
Monitoring environmental compliance across vast industrial and civic zones has historically been a challenge. **PrithviNet** is a real-time, IoT-driven platform for tracking, forecasting, and enforcing environmental standards for air, water, and noise.

## Core Features
1. **Real-Time Monitoring & Telemetry**: An intuitive Leaflet map dashboard (`index.html`) streaming live sensor data (Air Quality, Water Pollutants, Noise).
2. **Automated Compliance Engine**: Evaluates incoming telemetry against regulatory thresholds (`civic.html`) and instantly logs verifiable alerts when entities violate emissions standards.
3. **Entity Master Management**: Secure, role-based access control where administrators can register entities, configure sensor parameters, and update regional boundaries (`entities.html`).
4. **PrithviNet Copilot**: Powered by Google Gemini, the context-grounded AI assistant connects directly to compliance data to generate summaries, predict forecasts, and answer queries naturally (`copilot.html`).

## Architecture
- **Backend Coordinator**: Node.js & Express.
- **Database**: SQLite (`prithvinet.db`).
- **Telemetry Layer**: IoT Simulator generating Mock Sensor Data (`simulator.js`).
- **AI Integration**: Google Gemini via Copilot API.
- **Frontend Layer**: Web dashboards connected via SSE Data Streams.

## Made By
**Priority Thread**
