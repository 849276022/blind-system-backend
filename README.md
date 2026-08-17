# blind-help-backend

地铁无障碍护航微信小程序与公安调度控制台共用后端，适用于腾讯云微信云托管。

## 本地运行

无 MySQL 时会使用内存数据，适合接口联调；生产环境必须配置 MySQL。

```bash
npm install
npm start
```

默认监听 `8080`。

## 腾讯云托管环境变量

必填：

```text
PORT=8080
WX_APPID=wx504c106474975d60
WX_SECRET=在微信公众平台重置后的新 AppSecret
MYSQL_ADDRESS=云数据库内网地址
MYSQL_PORT=3306
MYSQL_USERNAME=数据库用户名
MYSQL_PASSWORD=数据库密码
MYSQL_DATABASE=blind_help
```

语音上传（可后置配置）：

```text
COS_SECRET_ID=腾讯云密钥 ID
COS_SECRET_KEY=腾讯云密钥 Key
COS_BUCKET=存储桶名称
COS_REGION=存储桶地域
```

不要把 `WX_SECRET`、数据库密码或 COS 密钥提交到 GitHub。

## 接口

- `GET /health`
- `POST /auth/wx-login`，请求体 `{ "code": "微信 wx.login 返回的 code" }`
- `POST /help-orders`，请求体 `{ id?, content?, station?, userName?, openid?, audioUrl? }`
- `GET /help-orders`
- `PUT /help-orders/:id/status`，请求体 `{ status, operator }`
- `POST /help-orders/:id/audio`，multipart 字段 `audio`
- `GET /help-orders/:id/logs`

状态值统一为：`waiting`、`assigned`、`arrived`、`completed`、`cancelled`。

## 云托管部署

选择“代码托管”或上传本目录，使用 `Dockerfile` 构建，容器端口填写 `8080`。先创建并绑定 MySQL，再设置环境变量，部署后访问 `/health` 验证。
