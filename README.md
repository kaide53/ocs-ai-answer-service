你知道的,我其实根本不会写js，我只是有这个想法所以"小小"的请教了一下chatgpt老师，轻喷。

--------------------------------------------------------------------------------------------
环境准备
1. 安装 Node.js 和 npm
   - 安装后验证：
     node -v
     npm -v
2. 初始化项目
   - 进入项目目录
   - 安装依赖：
     npm install
3. 配置环境变量
   - 复制 `.env.example` 为 `.env` 并填写你的 API 密钥
   - !!注意：linux或者macos中以"."开头的文件是隐藏文件，使用终端指令：
     cp .env.example .env
   - 使用vim或其他文本编辑器修改.env配置填写你自己的API密钥之类的
--------------------------------------------------------------------------------------------
自定义配置
1. 配置AI(默认使用deepseek的api，如果你需要使用自己的API的话可能需要自己研究一下，反正有chatgpt可以用😁)：
   - 修改 `.env` 文件中的：
     - `AI_API_URL`: API地址
     - `AI_API_KEY`: API密钥
     - `AI_MODEL`: 使用的模型名称
2. 修改提示词(我不确定修改了会不会导致问题)：
   - 编辑 `server.js` 中的 `prompt` 
   - 格式建议保持"题目+选项"的结构
--------------------------------------------------------------------------------------------
OCS题库配置
在OCS中配置题库时，请使用以下JSON配置：

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
--------------------------------------------------------------------------------------------
启动服务
   Mac/Linux:
    chmod +x start.sh
      ./start.sh
   Windows:
    start.bat
   或者直接使用Node运行:
      node server.js
 