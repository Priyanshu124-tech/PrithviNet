# PrithviNet Architecture

```mermaid
graph TD;
    %% Data Ingestion Layer
    Simulator((IoT Simulator\n`simulator.js`)) -->|Generates Mock Sensor Data\n(Air, Water, Noise)| Backend;

    %% Backend Layer
    subgraph "Node.js / Express Backend"
        Backend[Backend Coordinator\n`server/index.js`]
        DB[(SQLite DB\n`prithvinet.db`)]
        Engine{Compliance Engine\n`compliance-engine.js`}
        API_Entities[Entities API\n`/api/entities`]
        API_Alerts[Compliance API\n`/api/compliance`]
        API_Forecast[Forecast API\n`/api/forecast`]
        API_Copilot[Copilot API\n`/api/copilot`]
        SSE_Stream>SSE Data Stream\n`/api/stream`]
    end

    Backend -->|Saves Raw Telemetry| DB;
    Simulator -->|Feeds Data| Backend;
    Backend -->|Triggers Verification| Engine;
    Engine -.->|Cross-references| DB;
    Engine -->|Logs Alerts| DB;

    %% Data Streams
    Backend --> SSE_Stream;

    %% Endpoints routing
    DB --> API_Entities;
    DB --> API_Alerts;
    DB --> API_Forecast;
    DB --> API_Copilot;

    %% AI Integrations
    Gemini([Google Gemini 2.0 API])
    API_Copilot <-->|Context-Grounded Query| Gemini;

    %% Frontend Layer
    subgraph "PrithviNet Frontend UI"
        UI_Map[Leaflet Dashboard\n`index.html`]
        UI_Compliance[Compliance Tracker\n`civic.html`]
        UI_Copilot[Chat Interface\n`copilot.html`]
        UI_Entities[Master Management\n`entities.html`]
    end

    %% Frontend connections
    SSE_Stream -->|Live UI Updates| UI_Map;
    API_Entities <--> UI_Entities;
    API_Alerts <--> UI_Compliance;
    API_Forecast --> UI_Map;
    API_Copilot <--> UI_Copilot;

    %% Styling
    classDef ai fill:#3b82f6,stroke:#1e40af,stroke-width:2px,color:#fff;
    classDef db fill:#0f172a,stroke:#334155,stroke-width:2px,color:#38bdf8;
    classDef core fill:#059669,stroke:#064e3b,stroke-width:2px,color:#fff;
    classDef frontend fill:#f59e0b,stroke:#b45309,stroke-width:2px,color:#fff;
    
    class Gemini ai;
    class DB db;
    class Backend,Engine core;
    class UI_Map,UI_Compliance,UI_Copilot,UI_Entities frontend;
```
