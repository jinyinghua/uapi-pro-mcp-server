# chat-addition

基于 Vercel / Next.js 的 ChatGPT 接口中转与会话管理服务，兼容 OpenAI 风格接口，并保留 UAPI Pro 搜索 MCP 能力。

## 功能特性

- 🔐 **API Key 认证** - 基于 Bearer Token 的鉴权机制
- 💬 **Chat Completions 中转** - 提供 `/v1/chat/completions`
- 🖼️ **图片生成与任务查询** - 提供 `/v1/images/generations` 与 jobs 路由
- 🔀 **OpenAI 兼容生图供应商池** - 按模型聚合多个供应商、确定性负载均衡，并在失败时自动故障切换
- 🧩 **Session 管理面板** - 支持登录、注入、禁用、删除、导出会话
- 🌐 **MCP 搜索能力** - 保留 `search_web` 工具
- 🚀 **Vercel Serverless** - 支持无状态部署与弹性扩缩容

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env.local` 文件：

```env
# UAPI Pro API Key（可选，用于 search_web）
UAPI_PRO_API_KEY=your-uapi-pro-api-key

# API Keys（用于鉴权，逗号分隔）
MCP_API_KEYS=key1,key2,key3

# 应用 URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# 可选：KV / Redis
KV_REST_API_URL=
KV_REST_API_TOKEN=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# 可选：本地数据目录
DATA_DIR=/tmp/chat-addition
```

### 配置 OpenAI 兼容生图供应商

可选的 `OPENAI_IMAGE_PROVIDERS` 将多个实现 `POST /v1/images/generations` 的供应商聚合为一个生图池。对于一个模型，服务会根据图片任务 ID 选择起始供应商（使重试请求稳定落到同一供应商）；当该供应商超时或返回错误时，会依次尝试池中其他匹配供应商。

```env
PROVIDER_A_API_KEY=sk-provider-a
PROVIDER_B_API_KEY=sk-provider-b
OPENAI_IMAGE_PROVIDERS='[
  {
    "id": "provider-a",
    "baseUrl": "https://api.provider-a.example/v1",
    "apiKeyEnv": "PROVIDER_A_API_KEY",
    "models": ["gpt-image-1"],
    "modelMap": { "gpt-image-1": "dall-e-3" },
    "timeoutMs": 120000
  },
  {
    "id": "provider-b",
    "baseUrl": "https://api.provider-b.example/v1",
    "apiKeyEnv": "PROVIDER_B_API_KEY",
    "models": ["gpt-image-1"]
  }
]'
```

字段同时兼容下划线形式（如 `base_url`、`api_key_env`、`model_map`）。`models` 为空时，该供应商匹配所有模型；`modelMap` 用于把客户端模型名改写为供应商的模型名。自定义请求头可通过 `headers` 对象提供。供应商地址可以填到 `/v1`，也可以直接填到 `/v1/images/generations`。

只有匹配到供应商池的模型会走该适配器；未配置或不匹配时，仍使用原有 ChatGPT 会话生图后端。单供应商也可使用简写：

```env
OPENAI_IMAGE_BASE_URL=https://api.provider.example/v1
OPENAI_IMAGE_API_KEY=sk-your-key
OPENAI_IMAGE_MODELS=gpt-image-1,dall-e-3
```

客户端调用方式不变：

```bash
curl "$NEXT_PUBLIC_APP_URL/v1/images/generations" \
  -H "Authorization: Bearer key1" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"A watercolor red panda in a bamboo forest","size":"1024x1024","n":1}'
```

### 3. 本地开发

```bash
npm run dev
```

服务器将在 `http://localhost:3000` 启动。

## 主要接口

### OpenAI 兼容接口

- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `GET /v1/images/jobs/{jobId}`
- `GET /v1/images/jobs/{jobId}/files/{index}`
- `GET /v1/models`

### 管理接口

- `POST /auth/login-check`
- `GET /auth/status`
- `POST /auth/session`
- `POST /auth/session/{sid}/toggle`
- `POST /auth/session/{sid}/remove`
- `GET /auth/session/{sid}/download`
- `GET /auth/sessions/download`

### MCP 接口

- `POST /api/mcp`

## 客户端兼容性

可用于对接：

- NextChat
- OpenAI 风格客户端
- 自定义 Chat Completions / Images 客户端
- 标准 MCP 客户端

## 可用工具

### `search_web`

使用 UAPI Pro 搜索 API 进行智能网页搜索。

**参数：**
- `query`：搜索关键词
- `site`：限制站点
- `filetype`：限制文件类型
- `fetch_full`：是否抓取全文
- `sort`：排序方式 `relevance/date`
- `time_range`：时间范围 `day/week/month/year`

## 部署

```bash
npm i -g vercel
vercel login
vercel --prod
```

## 许可证

MIT License
