import { chromium } from 'playwright';

export async function renderOrderPdf(html) {
  if (Buffer.byteLength(html,'utf8') > 2 * 1024 * 1024) {
    throw new Error('HTML_SIZE_LIMIT');
  }
  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled:false,
      locale:'zh-CN',
      timezoneId:'Asia/Shanghai',
      serviceWorkers:'block'
    });
    try {
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.setContent(html, { waitUntil:'domcontentloaded', timeout:10000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(image => {
          if (!image.complete) return image.decode();
          if (image.naturalWidth === 0) throw new Error('image decode failed');
          return Promise.resolve();
        }));
      });
      const pdf = await page.pdf({
        format:'A4',
        printBackground:true,
        preferCSSPageSize:true,
        displayHeaderFooter:true,
        headerTemplate:'<div></div>',
        footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;">'+
          '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margin:{ top:'16mm',right:'12mm',bottom:'16mm',left:'12mm' }
      });
      if (pdf.length === 0) throw new Error('EMPTY_PDF');
      return pdf;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}