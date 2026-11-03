// Rewrite relation references only. Preserve values, identifiers, comments and dollar bodies.
function relation(name) {
  return name === 'products'
    ? 'product_records'
    : name === 'product_variants'
      ? 'product_variant_records'
      : name;
}
function rewriteCode(code) {
  return code
    .replace(
      /\b(FROM|JOIN|UPDATE|INTO)\s+((?:(?:public|"public")\.)?)("?)(products|product_variants)\3(?![\w])/gi,
      (_, head, schema, quote, name) =>
        `${head} ${schema}${quote}${relation(name.toLowerCase())}${quote}`,
    )
    .replace(
      /\bLOCK\s+TABLE\s+([\w".,\s]+?)(\s+IN\s+)/gi,
      (_, names, end) =>
        'LOCK TABLE ' +
        names.replace(/\b(products|product_variants)\b/gi, (name) =>
          relation(name.toLowerCase()),
        ) +
        end,
    );
}
export function rewriteProductStorageSql(sql) {
  if (typeof sql !== 'string') return sql;
  let output = '',
    code = '',
    i = 0;
  const flush = () => {
    output += rewriteCode(code);
    code = '';
  };
  while (i < sql.length) {
    if (sql[i] === "'") {
      flush();
      let j = i + 1;
      const escaped =
        i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w]/.test(sql[i - 2]));
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      output += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      const identifier = sql.slice(i, j);
      if (['"products"', '"product_variants"', '"public"'].includes(identifier))
        code += identifier;
      else {
        flush();
        output += identifier;
      }
      i = j;
      continue;
    }
    const dollar =
      sql[i] === '$'
        ? sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0]
        : undefined;
    if (dollar) {
      flush();
      const end = sql.indexOf(dollar, i + dollar.length);
      const j = end < 0 ? sql.length : end + dollar.length;
      output += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql.startsWith('--', i)) {
      flush();
      const end = sql.indexOf('\n', i);
      const j = end < 0 ? sql.length : end + 1;
      output += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      flush();
      let j = i + 2,
        depth = 1;
      while (j < sql.length && depth) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      }
      output += sql.slice(i, j);
      i = j;
      continue;
    }
    code += sql[i++];
  }
  flush();
  return output;
}
