function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[character]));
}

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('invalid amount');
  return new Intl.NumberFormat('zh-CN', {
    style:'currency', currency:'CNY'
  }).format(cents / 100);
}

export function orderHtml(order) {
  if (!Array.isArray(order.lines) || order.lines.length > 500) {
    throw new Error('line count limit exceeded');
  }
  const rows = order.lines.map((line,index) =>
    '<tr><td>'+String(index+1)+'</td><td>'+escapeHtml(line.sku)+'</td>'+
    '<td>'+escapeHtml(line.name)+'</td><td>'+escapeHtml(line.quantity)+'</td>'+
    '<td class="money">'+escapeHtml(formatMoney(line.amountCents))+'</td></tr>'
  ).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; '+
    'style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:">'+
    '<style>'+PRINT_CSS+'</style></head><body>'+
    '<h1>订单明细</h1><p>订单号：'+escapeHtml(order.id)+'</p>'+
    '<table><thead><tr><th>序号</th><th>SKU</th><th>名称</th><th>数量</th><th>金额</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table>'+
    '<section class="total">合计：'+escapeHtml(formatMoney(order.totalCents))+'</section>'+
    '</body></html>';
}

const PRINT_CSS = [
  '@page { size:A4; margin:16mm 12mm; }',
  'body { font-family:"Noto Sans CJK SC",sans-serif; font-size:10pt; color:#111; }',
  'table { width:100%; border-collapse:collapse; table-layout:fixed; }',
  'thead { display:table-header-group; }',
  'th,td { border:0.2mm solid #bbb; padding:2mm; overflow-wrap:anywhere; }',
  'tr { break-inside:avoid; }',
  '.money { text-align:right; white-space:nowrap; }',
  '.total { margin-top:4mm; break-inside:avoid; font-weight:bold; }'
].join('');