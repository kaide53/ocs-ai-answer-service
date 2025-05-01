# ocs-ai-answer-service

你知道的，我其实根本不会写 JS，我只是有这个想法，所以“小小”地请教了一下 ChatGPT老师，轻喷。

---

## ✨ 环境准备

### 1. 安装 Node.js 和 npm

安装后可以使用以下命令验证：

```bash
node -v
npm -v
```

### 2. 初始化项目

进入项目目录并安装依赖：

```bash
npm install
```

### 3. 配置环境变量

- 复制 `.env.example` 为 `.env`，并填写你的 API 密钥
- 注意：Linux 或 macOS 下，以 `.` 开头的文件是隐藏的，可以使用命令：

```bash
cp .env.example .env
```

- 使用任意文本编辑器修改 `.env` 文件，填写你自己的 API 信息

---

## 自定义配置

### 1. 配置 AI 接口（默认使用 DeepSeek）

如需更换为自己的 API，可修改 `.env` 中的配置：

```env
AI_API_URL=你的API地址
AI_API_KEY=你的API密钥
AI_MODEL=你想用的模型名
```

### 2. 修改提示词（Prompt）

你可以打开 `server.js` 文件，自定义 `prompt` 里的内容。  
---

## 📚 OCS 题库配置方式

在 OCS 插件中，添加如下 JSON 即可启用你的本地 AI 服务作为题库：

```json
[
  {
    "name": "AI本地题库",
    "url": "http://localhost:3000/answer",
    "method": "post",
    "contentType": "json",
    "type": "GM_xmlhttpRequest",
    "headers": {
      "Content-Type": "application/json"
    },
    "data": {
      "question": "${title}",
      "options": "${options}"
    },
    "handler": "return (res)=> res.code === 1 ? [res.question, res.answer] : undefined"
  }
]
```

---

## 🚀 启动服务

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

### Windows

```bash
start.bat
```

### 或者直接运行 Node 服务（适用于所有平台）

```bash
node server.js
```

---