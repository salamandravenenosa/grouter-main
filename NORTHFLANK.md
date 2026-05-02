# Deploy no Northflank (Docker)

## 1) Criar serviço

- New Service -> Deploy from Dockerfile
- Root directory: repositório deste projeto
- Dockerfile path: `Dockerfile`

## 2) Porta e healthcheck

- Public HTTP Port: `3099` (ou use `PORT`, se preferir porta dinâmica)
- Health check path: `/health`

## 3) Volume persistente

- Adicione 1 volume e monte em: `/data`
- Isso preserva banco SQLite, logs e estado do proxy.

## 4) Recursos (free)

- CPU: `0.2 vCPU` (mínimo recomendado)
- RAM: `512 MB` (recomendado para estabilidade)

## 5) Segurança obrigatória

- Ative `require_client_auth` no dashboard
- Crie Client API Keys para bloquear uso público sem chave

## 6) Endpoint final

- Base URL: `https://SEU-DOMINIO/v1`
- Health: `https://SEU-DOMINIO/health`
