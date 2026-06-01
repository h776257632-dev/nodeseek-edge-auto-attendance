# NodeSeek Edge 自动签到插件 v1.1

## 这版修了什么

旧版从扩展后台 / popup 直接请求：

```http
POST https://www.nodeseek.com/api/attendance?random=true
```

可能会返回：

```json
{
  "success": false,
  "message": "high risk action"
}
```

v1.1 改成：先打开或复用 `https://www.nodeseek.com/board` 页面，然后把签到请求注入到页面上下文里执行。

## 使用方法

1. 解压 zip
2. 打开 Edge：`edge://extensions/`
3. 打开“开发人员模式”
4. 建议先删除旧版插件
5. 点击“加载解压缩的扩展”
6. 选择解压后的文件夹：`nodeseek-edge-auto-attendance-v1.1-page-context`
7. 先在 Edge 里正常登录 NodeSeek
8. 点插件图标，点“立即签到”测试

## 推荐设置

- 启用自动签到：开
- 访问 NodeSeek 页面时自动尝试一次：开
- 每日定时到点自动打开 NodeSeek 页面签到：开
- 浏览器通知：按需开启

## 注意

- 这个插件不会保存你的 Cookie。
- 登录态由 Edge 浏览器自己管理。
- 如果还是出现 `high risk action`，说明站点风控仍然认为当前动作风险高。不要高频重试，建议改成只在你正常访问网页时自动尝试。
- 如果返回“今天已完成签到，请勿重复操作”，说明接口已经可用，只是当天已签到。
