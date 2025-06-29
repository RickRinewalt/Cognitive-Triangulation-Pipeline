# Cognitive Triangulation and Knowledge Graph Code Analysis Pipeline

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Welcome to a state-of-the-art, event-driven pipeline engineered to perform deep semantic analysis of software codebases. This system discovers, analyzes, and understands the intricate relationships within code, building a queryable, high-fidelity knowledge graph using Large Language Models (LLMs) and graph database technology.

This is not just a static analysis tool; it's a dynamic, scalable, and resilient platform for building a "living" model of your code's cognitive architecture.

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Cognitive Triangulation](#cognitive-triangulation)
  - [Event-Driven & Asynchronous Architecture](#event-driven--asynchronous-architecture)
  - [The Transactional Outbox Pattern](#the-transactional-outbox-pattern)
  - [Polyglot Persistence](#polyglot-persistence)
- [Architectural Blueprint](#architectural-blueprint)
  - [High-Level Diagram](#high-level-diagram)
  - [Component Breakdown](#component-breakdown)
- [The Data Pipeline: A Step-by-Step Journey](#the-data-pipeline-a-step-by-step-journey)
- [Key Features](#key-features)
- [Comparison to Existing Technologies](#comparison-to-existing-technologies)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Pipeline](#running-the-pipeline)
- [API Reference](#api-reference)
  - [Endpoints](#endpoints)
  - [WebSocket Events](#websocket-events)
- [Directory Structure](#directory-structure)
- [Database Schema](#database-schema)
  - [SQLite Schema](#sqlite-schema)
  - [Neo4j Graph Model](#neo4j-graph-model)
- [Contributing](#contributing)
- [License](#license)

## Overview

This system is architected to deconstruct a software repository and rebuild it as a knowledge graph. It achieves this by:

1.  **Discovering** all relevant files and directories, intelligently respecting `.gitignore` rules.
2.  **Analyzing** file contents using LLMs to extract key **Points of Interest (POIs)**, such as classes, functions, variables, and imports.
3.  **Triangulating Relationships** through a sophisticated multi-pass analysis, combining deterministic logic with contextual LLM queries to identify how POIs connect.
4.  **Building a Knowledge Graph** in Neo4j, representing the codebase as a network of nodes (POIs) and edges (relationships).
5.  **Providing Real-time Insight** into the analysis process through a robust REST and WebSocket API.
6.  **Maintaining Itself** by automatically cleaning up graph elements corresponding to deleted files.

The result is a powerful, queryable graph that enables advanced code navigation, dependency analysis, architectural validation, and impact analysis for refactoring.

## Core Concepts

The power of this system comes from the fusion of several key architectural patterns and concepts.

### Cognitive Triangulation

This is the core philosophy of the pipeline. Instead of relying on a single method to find relationships, I use multiple, independent "witnesses" to build confidence.

1.  **Deterministic Pass:** Identifies obvious, rule-based relationships (e.g., a file `CONTAINS` a class). This pass is fast and highly accurate.
2.  **Intra-File LLM Pass:** An LLM analyzes the POIs within a single file to find local relationships (e.g., function A `CALLS` function B in the same file).
3.  **Intra-Directory LLM Pass:** An LLM analyzes all POIs within a directory to find connections between files (e.g., one file `IMPORTS` an exported class from another).
4.  **Global LLM Pass:** After summarizing entire directories, an LLM analyzes these summaries to find high-level architectural relationships between different modules or services.

The `ConfidenceScoringService` then aggregates the "evidence" from these passes. A relationship reported by multiple passes receives a higher confidence score, filtering out noise and LLM hallucinations.

### Event-Driven & Asynchronous Architecture

The system is built on **BullMQ** and **Redis**, allowing for a highly scalable and decoupled architecture. Each stage of the pipeline is a queue, and each processing unit is a worker. This design means:

-   **Scalability:** You can run hundreds or thousands of workers across multiple machines to process massive codebases in parallel.
-   **Resilience:** If a worker fails while processing a job, BullMQ ensures the job is automatically retried, preventing data loss.
-   **Decoupling:** Each worker has a single responsibility. I can update, improve, or replace a worker (e.g., `FileAnalysisWorker`) without affecting the rest of the system.

### The Transactional Outbox Pattern

To ensure maximum reliability, I use the transactional outbox pattern via the `TransactionalOutboxPublisher`.

When a worker (like `FileAnalysisWorker`) processes a file, it doesn't immediately publish an event to the next queue. Instead, it writes its findings *and* an "event to be published" into the SQLite database within a single transaction.

A separate, dedicated `TransactionalOutboxPublisher` service polls this outbox table and reliably publishes the events to BullMQ. This guarantees **at-least-once delivery** and prevents a scenario where a worker crashes after performing its work but before it could enqueue the next job, which would otherwise halt the pipeline for that file.

### Polyglot Persistence

The system leverages two different databases for what they do best:

-   **SQLite (`better-sqlite3`):** Acts as the fast, transactional, and transient data store. It's perfect for the outbox pattern, storing intermediate POIs, and tracking job states. Its file-based nature makes it easy to manage per-run.
-   **Neo4j (Graph Database):** Serves as the final, persistent knowledge graph. It is optimized for storing and querying complex network relationships, making it the ideal destination for our analysis.

## Architectural Blueprint

### High-Level Diagram

```
+------------------+      +--------------------+      +-----------------------+      +-------------------+
|                  |----->|  File Analysis     |----->|  Relationship         |----->|                   |
|   EntityScout    |      |  Queue & Workers   |      |  Resolution Queues    |      |   GraphBuilder    |
| (Discover Files) |      |  (Extract POIs)    |      |  & Workers (Triangulate) |      | (Persist to Neo4j)|
|                  |----->| (Chunking, LLM)    |----->|  (Confidence Score)   |----->|                   |
+------------------+      +----------+---------+      +-----------+-----------+      +-------------------+
        |                          |                        |
        v                          v                        v
+-------------------------------------------------------------------------+
|                                                                         |
|  SQLite (Intermediate Storage: POIs, Relationships, Outbox, Evidence)   |
|                                                                         |
+-------------------------------------------------------------------------+
        ^                          ^                        ^
        |                          |                        |
+-------+--------------------------+------------------------+-------------+
|                                                                         |
|             Transactional Outbox Publisher (Reliable Eventing)          |
|                                                                         |
+-------------------------------------------------------------------------+
        |
        | Publishes to...
        v
+-------------------------------------------------------------------------+
|                                                                         |
|                BullMQ / Redis (Job Queues & Caching)                    |
|                                                                         |
+-------------------------------------------------------------------------+
```

### Component Breakdown

The pipeline is a collection of specialized agents and workers, each with a distinct role.

| Component | File Path | Purpose |
| :--- | :--- | :--- |
| **PipelineApiService** | `src/utils/pipelineApi.js` | Provides REST and WebSocket APIs for starting, stopping, and monitoring pipeline runs in real-time. The primary user control plane. |
| **EntityScout** | `src/agents/EntityScout.js` | The starting point. Scans the target directory, respects `.gitignore`, and enqueues files into `file-analysis-queue`. |
| **FileDiscoveryBatcher** | `src/workers/fileDiscoveryBatcher.js` | An intelligent batching worker that groups files based on token count to optimize LLM API calls, improving efficiency and reducing cost. |
| **FileAnalysisWorker** | `src/workers/fileAnalysisWorker.js` | Consumes jobs from `file-analysis-queue`. Reads file content, chunks large files, and uses an LLM to extract POIs. Publishes findings to the transactional outbox. |
| **DirectoryAggregationWorker** | `src/workers/directoryAggregationWorker.js` | A coordination worker that uses Redis to track when all files within a single directory have been analyzed, triggering the `DirectoryResolutionWorker`. |
| **DirectoryResolutionWorker**| `src/workers/directoryResolutionWorker.js` | Uses an LLM to generate a high-level summary of a directory's purpose based on the contents of its files. |
| **TransactionalOutboxPublisher**|`src/services/TransactionalOutboxPublisher.js`| Polls the SQLite `outbox` table and reliably publishes events to the appropriate BullMQ queues, ensuring data consistency and at-least-once delivery. |
| **RelationshipResolver** | `src/agents/RelationshipResolver.js` | Orchestrates the multi-pass relationship extraction process (deterministic, intra-file, intra-directory, global). This is the "brain" of the analysis. |
| **RelationshipResolutionWorker**|`src/workers/relationshipResolutionWorker.js`| A dedicated worker that takes a single POI and its context, queries an LLM to find relationships, and writes findings to the outbox. |
| **ValidationWorker** | `src/workers/ValidationWorker.js` | Consumes analysis findings, stores them as "evidence" in SQLite, and uses Redis to determine when a relationship has enough evidence to be reconciled. |
| **ReconciliationWorker** | `src/workers/ReconciliationWorker.js` | Takes a relationship with all its evidence, uses `ConfidenceScoringService` to calculate a final score, and persists validated relationships to the main `relationships` table. |
| **GraphBuilder** | `src/agents/GraphBuilder.js` | The final step. Reads validated, high-confidence relationships from SQLite and executes efficient Cypher queries to build the final knowledge graph in Neo4j. |
| **SelfCleaningAgent** | `src/agents/SelfCleaningAgent.js` | A maintenance agent that runs to find files that have been deleted from the filesystem and removes their corresponding nodes and relationships from the databases. |
| **AnthropicClient** | `src/utils/anthropicClient.js`| A native, dependency-free client for the Anthropic Claude Sonnet 4 API, featuring concurrency management, automatic retries, and backoff logic. |
| **LLMResponseSanitizer**|`src/utils/LLMResponseSanitizer.js`| A defensive utility that cleans and repairs common formatting issues in LLM JSON output, making parsing more resilient. |
| **QueueManager** | `src/utils/queueManager.js` | A singleton wrapper around BullMQ that manages all queue and worker connections to Redis. |
| **DatabaseManager** | `src/utils/sqliteDb.js` | Manages the connection and schema for the SQLite database. |
| **neo4jDriver** | `src/utils/neo4jDriver.js` | Manages the singleton connection to the Neo4j graph database. |

## The Data Pipeline: A Step-by-Step Journey

Here is how a single file travels through the system:

1.  **Initiation**: A user submits a new pipeline run via the `POST /api/pipeline/start` endpoint, specifying a target directory.
2.  **Discovery**: `EntityScout` awakens, scans the directory, and creates a "file-analysis" job for every discovered file, placing it in the `file-analysis-queue`.
3.  **POI Extraction**: A `FileAnalysisWorker` picks up a job. It reads the file, asks the LLM to identify all POIs (functions, classes, etc.), and writes these POIs along with an event into the SQLite `outbox` table in a single transaction.
4.  **Reliable Eventing**: The `TransactionalOutboxPublisher` polls the `outbox`, sees the new event, and publishes it to the `relationship-resolution-queue`.
5.  **Relationship Triangulation**: A `RelationshipResolutionWorker` receives the POI. It orchestrates the multi-pass analysis, querying the LLM with different contexts to find potential relationships. Each piece of evidence is written to the `outbox`.
6.  **Evidence Validation**: The `ValidationWorker` consumes these evidence events from the outbox. It stores them in the `relationship_evidence` table and uses Redis to track how much evidence has been gathered for a specific potential relationship.
7.  **Reconciliation & Scoring**: Once all evidence for a relationship is collected, the `ValidationWorker` enqueues a job for the `ReconciliationWorker`. This worker fetches all evidence, calculates a final `confidence_score` using `ConfidenceScoringService`, and if the score exceeds a threshold, writes the final, validated relationship to the main `relationships` table in SQLite.
8.  **Graph Construction**: After all analysis jobs are complete, the `GraphBuilder` agent runs. It reads all validated relationships from SQLite and bulk-inserts them into Neo4j, creating the final, queryable knowledge graph.
9.  **Monitoring**: Throughout this entire process, status updates are broadcast via WebSocket, allowing a user to monitor the progress in real-time.
10. **Cleanup**: If a file is ever deleted from the source repository, the `SelfCleaningAgent` can be run to find and remove its corresponding data from both SQLite and Neo4j, keeping the graph synchronized with the codebase.

## Key Features

-   **Deep Semantic Analysis**: Goes far beyond simple pattern matching by using LLMs to understand code intent and context.
-   **Highly Scalable**: The distributed worker/queue architecture allows for massive parallel processing of large and complex codebases.
-   **Extremely Reliable**: The transactional outbox pattern guarantees that no analysis work is lost, even if parts of the system crash.
-   **Confidence-Scored Relationships**: The "Cognitive Triangulation" approach filters out LLM noise and produces a high-fidelity graph.
-   **Real-time Monitoring**: A built-in API and WebSocket server provide immediate insight into the pipeline's status, progress, and logs.
-   **Automated Graph Construction**: Fully automates the process of turning a directory of code into a queryable Neo4j knowledge graph.
-   **Language Agnostic**: Because it relies on LLMs, the system can be adapted to analyze code in any programming language.

## Comparison to Existing Technologies

| Feature | Your System | Static Analysis Tools (SonarQube, ESLint) | Code Search Tools (Sourcegraph) | AI Code Assistants (GitHub Copilot) |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Goal** | Build a queryable graph of semantic relationships. | Find bugs, enforce code style, measure quality. | Search, navigate, and understand code. | Suggest code, answer questions. |
| **Relationship Extraction** | **Advanced**, multi-pass, confidence-scored. | **Limited**, rule-based (e.g., unused imports). | No, provides "find references" only. | **Limited**, contextual but not exhaustive. |
| **LLM-Based Analysis** | **Core Component** for deep understanding. | No. | No (traditionally). | **Core Component** for suggestions. |
| **Persistent Knowledge Graph** | **Yes**, creates a Neo4j graph. | No. | No (builds a search index). | No. |
| **Real-time Monitoring** | **Yes**, via REST and WebSocket API. | No. | No. | No. |
| **Scalability** | **High**, designed with distributed queues. | Varies, often monolithic scans. | High, designed for large-scale indexing. | N/A (Cloud Service). |
| **Reliability** | **High**, via Transactional Outbox. | N/A. | N/A. | N/A. |

## Getting Started

Follow these steps to get the pipeline running on your local machine.

### Prerequisites

-   **Node.js**: v18.x or later recommended.
-   **Redis**: An instance of Redis for BullMQ. Can be run locally or via Docker.
-   **Neo4j**: A Neo4j instance (v5.x recommended). Can be run locally or via Docker.
-   **Anthropic API Key**: You need an API key from [Anthropic](https://console.anthropic.com/) for Claude.

### Installation

1.  **Clone the Repository:**
    ```sh
    git clone https://github.com/yourusername/cognitive-triangulation-pipeline.git
    cd cognitive-triangulation-pipeline
    ```

2.  **Install Dependencies:**
    ```sh
    npm install
    ```

### Configuration

1.  **Create an Environment File:**
    Copy the example environment file:
    ```sh
    cp .env.example .env
    ```

2.  **Edit `.env`:**
    Open the `.env` file and fill in the details for your local setup:
    ```dotenv
    # --- LLM API Configuration ---
    # Get your key from https://console.anthropic.com/
    ANTHROPIC_API_KEY=sk-ant-api03-your_secret_api_key

    # --- Redis Configuration ---
    # URL for your Redis instance
    REDIS_URL=redis://127.0.0.1:6379

    # --- Neo4j Database Configuration ---
    # URI for your Neo4j instance
    NEO4J_URI=bolt://localhost:7687
    NEO4J_USER=neo4j
    # Use a secure password, especially in production
    NEO4J_PASSWORD=your_secure_password
    NEO4J_DATABASE=neo4j

    # --- SQLite Database Configuration ---
    # Path where the intermediate SQLite database will be stored
    SQLITE_DB_PATH=./database.db
    ```

### Running the Pipeline

The system includes a user-friendly API server for managing runs.

1.  **Initialize the Database Schema:**
    This command will create the `database.db` file and set up the necessary tables.
    ```sh
    npm run init-db
    ```

2.  **Start the API Server:**
    This will start the web server and the WebSocket server for real-time updates.
    ```sh
    npm run start-api
    ```
    You should see output indicating the server is running on `http://localhost:3002`.

3.  **Submit a Pipeline Run:**
    Use `curl` or any API client to send a `POST` request to the `/api/pipeline/start` endpoint. Replace `/path/to/your/codebase` with the absolute path to the directory you want to analyze.

    ```sh
    curl -X POST http://localhost:3002/api/pipeline/start \
      -H "Content-Type: application/json" \
      -d '{"targetDirectory": "/path/to/your/codebase"}'
    ```

4.  **Monitor the Progress:**
    -   **Terminal:** Watch the console output from the `npm run start-api` command.
    -   **REST API:** Get the status of a specific run:
        `GET http://localhost:3002/api/pipeline/status/:pipelineId`
    -   **WebSocket:** Connect a WebSocket client to `ws://localhost:3002` to receive real-time JSON patches of the pipeline status.

Once the pipeline completes, you can explore the generated knowledge graph in your Neo4j Browser.

## API Reference

The `PipelineApiService` provides the following endpoints:

### Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | `GET` | Health check to confirm the server is running. |
| `/api/pipeline/start` | `POST` | Starts a new analysis pipeline run. **Body:** `{ "targetDirectory": "/path/to/code" }`. |
| `/api/pipeline/status/:pipelineId` | `GET` | Retrieves the detailed current status and logs for a specific pipeline run. |
| `/api/pipeline/active` | `GET` | Lists all currently active or recently completed pipeline runs managed by the server. |
| `/api/pipeline/stop/:pipelineId` | `POST` | Requests a graceful stop for a running pipeline. |
| `/api/pipeline/clear/:pipelineId` | `DELETE` | Clears the history of a completed or failed pipeline run from the server's memory. |

### WebSocket Events

Connect to `ws://localhost:3002` to receive real-time updates.

| Event Type | Payload Description |
| :--- | :--- |
| `initial_state` | Sent on connection. Provides a full list of all active pipelines. |
| `pipeline_update` | Sent whenever a pipeline's status, progress, or logs are updated. Contains the full data object for the specific pipeline that changed. |

## Directory Structure

```
src/
├── agents/             # High-level orchestrators (EntityScout, GraphBuilder)
├── workers/            # Single-responsibility, queue-driven workers
├── services/           # Core services (LLM Client, Outbox Publisher)
├── utils/              # Shared utilities (DB drivers, queue manager, logger)
├── config/             # Application configuration
├── main.js             # Main CLI entry point for the pipeline
└── ...
```

## Database Schema

### SQLite Schema

Defined in `src/utils/schema.sql`, the SQLite database serves as the pipeline's operational datastore.

-   **`files`**: Tracks discovered files and their processing status.
-   **`pois`**: Stores Points of Interest extracted from files.
-   **`relationships`**: Stores **validated** relationships with their final confidence scores.
-   **`relationship_evidence`**: Stores all raw "evidence" for potential relationships from different analysis passes before reconciliation.
-   **`directory_summaries`**: Stores the LLM-generated summaries for each directory.
-   **`outbox`**: The transactional outbox table for reliable event publishing.

### Neo4j Graph Model

The final graph in Neo4j is simple and powerful:

-   **Nodes**:
    -   `:POI`: All Points of Interest are stored as nodes with this label.
    -   Properties: `id`, `type`, `name`, `filePath`, `startLine`, `endLine`.
-   **Relationships**:
    -   `:RELATIONSHIP`: A generic relationship type between two `:POI` nodes.
    -   Properties: `type` (e.g., 'CALLS', 'IMPORTS', 'CONTAINS'), `confidence`.

## Contributing

Contributions are welcome! This project is ambitious, and there are many avenues for improvement, from performance tuning to enhancing the LLM prompts for even more nuanced analysis. Please open an issue to discuss your ideas or submit a pull request.

## License

This project is licensed under the [MIT License](LICENSE).