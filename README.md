# droid2api

OpenAI 兼容的 API 代理服务器，统一访问不同的 LLM 模型。

> 讨论群：[824743643](https://qm.qq.com/q/cm0CWAEFGM)，使用问题、建议或交流均可。

## 项目结构

```
droid2api/
├── server.js                 # 服务器入口
├── config/
│   └── app.yaml              # 应用配置文件（支持热加载）
├── src/
│   ├── app.js                # Express 应用实例
│   ├── config/
│   │   └── index.js          # 配置管理（YAML 加载 + 热加载）
│   ├── middleware/
│   │   ├── cors.js           # CORS 跨域中间件
│   │   └── error-handler.js  # 错误处理中间件
│   ├── routes/
│   │   └── api.js            # API 路由定义
│   ├── services/
│   │   ├── auth.js           # 认证服务
│   │   ├── proxy-manager.js  # 代理管理
│   │   └── user-agent-updater.js  # UA 版本更新
│   ├── transformers/
│   │   ├── request-anthropic.js   # Anthropic 请求转换
│   │   ├── request-openai.js      # OpenAI 请求转换
│   │   ├── request-common.js      # 通用请求转换
│   │   ├── response-anthropic.js  # Anthropic 响应转换
│   │   └── response-openai.js     # OpenAI 响应转换
│   └── utils/
│       ├── logger.js         # 日志工具
│       └── id-generator.js   # UUID/ULID 生成
├── data/                     # 运行时数据目录
├── docker-compose.yml        # Docker Compose 配置
├── Dockerfile                # Docker 镜像构建
└── package.json
```

## 核心功能

### 🔧 YAML 配置 + 热加载

- **统一配置文件** - 所有配置集中在 `config/app.yaml`，清晰易读
- **热加载** - 修改配置文件后自动生效，无需重启服务
- **认证集成** - API 密钥可在配置文件中直接设置，也支持环境变量

### 🔐 多账户认证 + 轮询

- **factory_api_keys** - 固定 API 密钥，支持多个轮询
- **refresh_keys** - 刷新令牌，支持多账户轮询，自动每 6 小时刷新
- **客户端 Authorization** - 使用请求头中的 Authorization 字段
- **智能优先级** - factory_api_keys > refresh_keys > 客户端 Authorization
- **运行时状态分离** - 配置在 `config/app.yaml`，运行时令牌自动保存在 `data/auth.json`

### 🧠 智能推理控制

- **六档推理级别** - `auto` / `off` / `low` / `medium` / `high` / `xhigh`
- **auto 模式** - 完全遵循客户端原始请求
- **OpenAI 模型** - 自动注入 `reasoning` 字段
- **Anthropic 模型** - 自动配置 `thinking` 字段和 `budget_tokens`

### 💻 Claude Code 集成

- **透明代理** - `/v1/responses` 和 `/v1/messages` 端点直接转发
- **系统提示注入** - 自动添加 Droid 身份标识
- **零配置使用** - 设置 API Base URL 即可

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置认证

编辑 `config/app.yaml`，在 `auth` 节中填入密钥：

```yaml
auth:
  # 方式1：固定 API 密钥（多个时轮询）
  factory_api_keys:
    - "your_api_key_1"
    - "your_api_key_2"

  # 方式2：刷新令牌（多账户轮询，自动刷新）
  refresh_keys:
    - "your_refresh_token_1"
    - "your_refresh_token_2"
```

也可通过环境变量设置（逗号分隔多个值，与配置文件合并）：

```bash
export FACTORY_API_KEY="key1,key2"
# 或
export DROID_REFRESH_KEY="token1,token2"
```

> 💡 无需配置也能启动，此时将使用客户端请求头中的 Authorization。
> 💡 refresh_keys 只需填一次初始值，运行时刷新后的最新令牌自动保存在 `data/auth.json`。

### 3. 启动服务

```bash
npm start
```

服务器默认运行在 `http://localhost:3000`。

## 配置说明

所有配置集中在 `config/app.yaml`，支持热加载（修改后自动生效）。

### 模型配置

```yaml
models:
  - name: "Sonnet 4.5"
    id: "claude-sonnet-4-5-20250929"
    type: anthropic          # 端点类型: anthropic / openai / common
    reasoning: auto          # 推理级别: auto / off / low / medium / high / xhigh
    provider: anthropic      # 提供商标识
```

### 推理级别说明

| 级别 | 行为 | Anthropic budget_tokens | OpenAI effort |
|------|------|-------------------------|---------------|
| `auto` | 遵循客户端原始请求 | - | - |
| `off` | 强制关闭推理 | - | - |
| `low` | 轻度推理 | 4,096 | low |
| `medium` | 中度推理 | 12,288 | medium |
| `high` | 深度推理 | 24,576 | high |
| `xhigh` | 超深度推理 | 40,960 | xhigh |

### 模型重定向

```yaml
model_redirects:
  claude-3-5-haiku-20241022: "claude-haiku-4-5-20251001"
```

### 代理配置

```yaml
proxies:
  - name: "default-proxy"
    url: "http://127.0.0.1:3128"
  - name: "auth-proxy"
    url: "http://username:password@host:port"
```

多个代理会按轮询方式使用。

## Docker 部署

### 使用 Docker Compose（推荐）

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

认证配置可选以下任一方式：

**方式1：在 `config/app.yaml` 中配置（推荐，支持热加载 + 多账户）：**

```yaml
auth:
  factory_api_keys:
    - "key1"
    - "key2"
  # 或
  refresh_keys:
    - "token1"
    - "token2"
```

**方式2：通过环境变量（创建 `.env` 文件，逗号分隔多个值）：**

```env
FACTORY_API_KEY=key1,key2
# 或
DROID_REFRESH_KEY=token1,token2
```

**方式3：直接在 docker run 中设置：**

```bash
docker build -t droid2api .

docker run -d \
  -p 3000:3000 \
  -v ./config:/app/config \
  -v ./data:/app/data \
  -e FACTORY_API_KEY="key1,key2" \
  --name droid2api \
  droid2api
```

> 💡 `docker-compose.yml` 默认挂载 `config/` 目录，容器运行时修改 `config/app.yaml` 即可热加载。

### 云平台部署

支持 Render、Railway、Fly.io、Google Cloud Run、AWS ECS 等平台，将 `FACTORY_API_KEY` 或 `DROID_REFRESH_KEY` 设为环境变量即可。

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /v1/models` | 获取可用模型列表 |
| `POST /v1/chat/completions` | 标准 OpenAI 聊天补全（自动格式转换） |
| `POST /v1/responses` | OpenAI Responses API 直接转发 |
| `POST /v1/messages` | Anthropic Messages API 直接转发 |
| `POST /v1/messages/count_tokens` | Anthropic token 计数 |

### 使用示例

```bash
# 获取模型列表
curl http://localhost:3000/v1/models

# 流式对话
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### Claude Code 集成

在 Claude Code 中设置 API Base URL：

```
http://localhost:3000
```

自动功能：
- ✅ 系统提示注入
- ✅ 认证头自动添加
- ✅ 推理级别自动配置

## 常见问题

### 配置修改后需要重启吗？

不需要。`config/app.yaml` 支持热加载，保存后自动生效。

### 认证优先级是什么？

1. `factory_api_keys`（环境变量 + 配置文件合并）→ 最高优先级
2. `refresh_keys`（环境变量 + 配置文件合并）→ 次高优先级
3. 客户端 Authorization 头 → 最低

每个优先级内，多个密钥/账户按**轮询**方式分配请求。

### data/auth.json 是什么？

运行时自动生成的令牌状态文件。refresh_keys 每次刷新后会获得新的一次性 token，自动保存到此文件。你无需手动编辑，但请勿删除（删除后需要重新填入有效的初始 refresh_key）。

### 如何开启调试日志？

在 `config/app.yaml` 中设置：

```yaml
dev_mode: true
```

### 端口被占用怎么办？

修改 `config/app.yaml` 中的 `port` 字段：

```yaml
port: 8080
```

## 许可证

MIT
