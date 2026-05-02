# grouter-main (copia limpa)

Esta copia foi preparada sem contas/sessoes locais e pronta para Docker/Render.

## 1) Rodar local com Docker

Requisitos:
- Docker Desktop instalado

Passos:
1. Abra terminal na pasta `C:\Users\Panhard-Dev\Downloads\grouter-main`
2. Build da imagem:
   ```bash
   docker build -t grouter-main .
   ```
3. Suba o container:
   ```bash
   docker run --name grouter-main -p 3099:3099 -e PORT=3099 -e RENDER=false grouter-main
   ```
4. Teste:
   - `http://localhost:3099/health`
   - `http://localhost:3099/v1/models`

## 2) Usar no Render (Docker)

1. Suba esta pasta para um repositorio no GitHub.
2. No Render: `New` -> `Web Service`.
3. Selecione o repo e configure:
   - Runtime: `Docker`
   - Branch: `main`
   - Dockerfile Path: `./Dockerfile`
4. Variaveis de ambiente:
   - `RENDER=true`
   - `RENDER_EXTERNAL_URL=https://SEU-SERVICO.onrender.com`
   - Opcional: `GROUTER_KEEP_ALIVE_MS=240000`
5. Deploy e teste:
   - `https://SEU-SERVICO.onrender.com/health`

## 3) Endpoint OpenAI-compatible

Base URL:
- `https://SEU-SERVICO.onrender.com/v1`

Endpoints:
- `POST /chat/completions`
- `GET /models`

Exemplo de chamada:
```bash
curl -X POST "https://SEU-SERVICO.onrender.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex/gpt-5.4",
    "messages": [{"role":"user","content":"oi"}]
  }'
```

## 4) Importante sobre contas

- Esta copia NAO leva contas/tokens locais.
- Para funcionar no deploy, adicione conexoes/contas novamente pelo dashboard do projeto.
