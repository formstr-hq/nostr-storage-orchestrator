# Orchestrator

This repository contains the Orchestrator project and its related services.

## Project Structure

```
.
├── proxy
│   ├── blossom
│   ├── relay
│   └── storage-client
├── node_modules
├── package.json
└── README.md
```

## Prerequisites

- Node.js (recommended latest LTS)
- npm
- Docker
- Docker Compose

---

## Installation

Install root dependencies first:

```bash
npm install
```

This will create the required `node_modules` directory at the repository root.

---

## Running Storage Client

Navigate to the storage client directory:

```bash
cd storage-client
```

Start the service using Docker Compose:

```bash
docker compose up --build
```

This will build and start all required containers.

---

## Building and Running Blossom

Navigate to the Blossom service:

```bash
cd proxy/blossom
```

Build the project:

```bash
npm run build
```

Start the application:

```bash
npm run start
```

---

## Development Workflow

1. Install root dependencies:

   ```bash
   npm install
   ```

2. Start Storage Client:

   ```bash
   cd storage-client
   docker compose up --build
   ```

3. In a separate terminal, build and start Blossom:

   ```bash
   cd proxy/blossom
   npm run build
   npm run start
   ```

---

## Environment Variables

Blossom uses environment configuration files:

```bash
proxy/blossom/.env
```

Refer to:

```bash
proxy/blossom/.env.example
```

for the required environment variables.

---

## Notes

- Ensure Docker is running before starting the Storage Client.
- Configure all required environment variables before starting Blossom.
- Rebuild Blossom after making changes if necessary:

```bash
npm run build
```