// One identity rule for API writes, workbook imports and reconciliation plans.
export const normalizeCategoryName = (name) =>
  name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
