# 项目交接说明

项目：安徽上岩科技 AI 工具站

线上站点： https://anhui-shangyan-ai-tools.netlify.app

GitHub 仓库： https://github.com/zihao980902/anhui-shangyan-ai-tools

Netlify siteId：42278a8e-4a93-4f2a-99d9-621a008da304

内部访问码：shangyanduanshipin

## 当前功能

- 内部访问码登录
- gpt-image-2 生图
- 质量档位：low / medium / high
- 清晰度档位：1K / 2K / 4K
- 画幅：1:1、9:16、16:9、4:5
- 多张参考图上传，最多取前 6 张
- 生成历史记录
- 图片下载

## 环境变量

密钥不要写入代码仓库。需要在 Netlify 项目环境变量里配置：

- AI_IMAGE_API_KEY
- AI_IMAGE_API_URL
- AI_IMAGE_API_AUTH_HEADER
- AI_IMAGE_API_AUTH_PREFIX
- INTERNAL_ACCESS_CODE

## 部署说明

如果 Netlify 已连接 GitHub 仓库，推送到 main 分支后会自动部署。

如果 Netlify 没有连接 GitHub，需要在 Netlify 项目里连接仓库：

1. 打开 Netlify 项目 anhui-shangyan-ai-tools
2. 进入 Build & deploy
3. 连接 GitHub 仓库 zihao980902/anhui-shangyan-ai-tools
4. Build command 使用 npm run build
5. Publish directory 使用 dist

## 注意

用户曾在聊天中粘贴过接口密钥。为了安全，建议在云雾 AI 后台重新生成新密钥，并把 Netlify 环境变量替换为新密钥。
