# @hasna/predictor

Swarm intelligence prediction engine — multi-agent simulation, persona generation, social dynamics, emergent behavior analysis

[![npm](https://img.shields.io/npm/v/@hasna/predictor)](https://www.npmjs.com/package/@hasna/predictor)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/predictor
```

## CLI Usage

```bash
predictor --help
```

- `predictor create`
- `predictor simulate`
- `predictor status`
- `predictor list`
- `predictor report`

## MCP Server

```bash
predictor-mcp
```

13 tools available.

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service predictor
cloud sync pull --service predictor
```

## Data Directory

Data is stored in `~/.hasna/predictor/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
