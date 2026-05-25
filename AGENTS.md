# TikTok Video Generator

> 详细项目文档见 `docs/PROJECT_STATUS.md`

## 开发服务器启动规则

**每次启动必须同时启动前后端**，缺一不可：

```
preview_start("Frontend (Vite)")   # 端口 5173
preview_start("Backend (Express)") # 端口 3001，连接 AWS RDS
```

只启动前端会导致 `/api` 代理到空端口，前端报 `Unexpected end of JSON input`。
