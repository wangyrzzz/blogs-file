# HTML 动态渲染并转换为 PDF

把 HTML 转成 PDF 常见于合同、对账单、发票和运营报表。难点不在于调用一个转换 API，而在于动态数据、字体、分页、图片、资源加载和安全控制。对于现代 CSS 和 JavaScript 页面，优先使用真正的浏览器内核进行渲染。

## 一、选择渲染方式

- 简单静态 HTML：可以使用 wkhtmltopdf 等传统工具；
- 需要现代 CSS、字体和 JavaScript：使用 Chromium、Playwright 或 Puppeteer；
- 高并发、固定模板：可使用独立渲染服务或浏览器实例池；
- 极高一致性要求：固定浏览器版本、字体包和模板版本，并做视觉回归测试。

浏览器渲染通常比字符串拼接 PDF 更接近用户看到的页面，但资源和进程成本也更高。

## 二、推荐的渲染流程

1. 服务端根据业务数据生成不可修改的 HTML；
2. 将图片、CSS 和字体使用可信的本地路径或受控 URL；
3. 启动或复用浏览器上下文；
4. 等待数据渲染和字体加载完成；
5. 设置纸张、边距、页眉页脚和背景打印选项；
6. 生成 PDF，校验文件大小和页数后返回或上传对象存储。

## 三、Playwright Java 示例

```java
try (Playwright playwright = Playwright.create();
     Browser browser = playwright.chromium().launch(
             new BrowserType.LaunchOptions().setHeadless(true))) {
    Page page = browser.newPage();
    page.setContent(html, new Page.SetContentOptions()
            .setWaitUntil(LoadState.NETWORKIDLE));
    page.evaluate("document.fonts && document.fonts.ready");
    byte[] pdf = page.pdf(new Page.PdfOptions()
            .setFormat("A4")
            .setPrintBackground(true)
            .setMargin(new Margin().setTop("16mm").setBottom("16mm")));
}
```

示例只展示核心流程。生产环境应复用浏览器进程、限制并发上下文数量，并在超时、浏览器崩溃和页面加载失败时释放资源。具体依赖版本应与项目 JDK 和浏览器驱动匹配。

## 四、分页控制

通过 CSS 控制分页：

```css
.page-break {
  break-before: page;
}

table, tr, img {
  break-inside: avoid;
}

@page {
  size: A4;
  margin: 16mm 12mm;
}
```

复杂表格不要只依赖浏览器自动分页，应为表头重复、长文本换行、合计行和跨页规则准备专门模板。中文字体缺失是最常见的“本地正常、服务器乱码”原因之一，部署时要显式安装并验证字体。

## 五、动态资源与安全

如果 HTML 中引用外部图片、CSS 或接口，渲染结果会受网络和权限影响。推荐提前把资源准备到可信存储，或以内嵌 Data URL 的方式传入。浏览器上下文应限制访问内网地址、云元数据地址和不可信 URL，防止 SSRF。

模板数据要进行 HTML 转义，不能把用户输入直接拼成脚本。PDF 服务应限制单次 HTML 长度、图片像素、渲染超时和并发数，避免恶意内容耗尽 CPU 或内存。

## 六、异步生成与下载

大文件和复杂报表适合异步生成：业务记录保存 `PENDING`、`PROCESSING`、`SUCCESS`、`FAILED` 状态，任务队列负责执行，成功后返回短期下载地址。下载接口再次校验用户、租户和资源归属，不要把永久对象存储地址直接暴露给客户端。

## 七、排查空白页和布局错乱

优先确认 HTML 是否包含正确数据，再检查字体、图片响应、浏览器控制台错误和网络请求。若页面依赖前端异步请求，必须等待明确的业务完成标记，而不是盲目 `sleep`。对关键模板保存固定样例并做 PDF 文本和截图对比，能提前发现升级浏览器带来的布局变化。

## 总结

HTML 转 PDF 是一个渲染系统问题。稳定方案需要固定浏览器和字体环境、等待动态内容、控制分页、限制资源访问，并把大任务放进可重试的异步流程中。
