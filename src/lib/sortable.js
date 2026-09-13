// Tiny click-to-sort behaviour for plain <table> markup — no grid library,
// consistent with keeping dependencies few. Mark a header `<th data-sort>`
// (optionally `data-sort="number"`) and call `makeSortable(table)` once
// after the table is in the DOM.

export function makeSortable(table) {
  const headers = table.querySelectorAll('thead th[data-sort]');
  headers.forEach((th) => {
    th.style.cursor = 'pointer';
    th.title = 'Click to sort';
    th.addEventListener('click', () => sortByColumn(table, th));
  });
}

function sortByColumn(table, th) {
  const headerCells = Array.from(th.parentElement.children);
  const columnIndex = headerCells.indexOf(th);
  const numeric = th.dataset.sort === 'number';
  const ascending = th.dataset.sortDir !== 'asc';
  headerCells.forEach((h) => delete h.dataset.sortDir);
  th.dataset.sortDir = ascending ? 'asc' : 'desc';

  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a, b) => {
    const av = cellValue(a, columnIndex, numeric);
    const bv = cellValue(b, columnIndex, numeric);
    if (av < bv) return ascending ? -1 : 1;
    if (av > bv) return ascending ? 1 : -1;
    return 0;
  });
  rows.forEach((row) => tbody.appendChild(row));
}

function cellValue(row, index, numeric) {
  const text = row.children[index]?.textContent.trim() ?? '';
  return numeric ? parseFloat(text) || 0 : text.toLowerCase();
}
