import ts from 'typescript';

// Строки верхнего уровня, от которых после компиляции не остаётся кода: импорт и экспорт только типов,
// объявления типов и интерфейсов, `declare`. Node 22 считает их непокрытыми, Node 24 — нет, поэтому
// порог по файлу на маленьком модуле зависел бы от версии Node.
export function erasedLines(source: string): Set<number> {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = new Set<number>();
  for (const statement of file.statements) {
    if (!isErased(statement)) continue;
    const first = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
    const last = file.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

function isErased(statement: ts.Statement): boolean {
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return true;
  if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((e) => e.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return true;
    const clause = statement.exportClause;
    return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  return false;
}

// Строки LCOV без стёртых: LF — исполнимые строки, LH — исполненные из них.
export function countLines(hits: Map<number, number>, erased: Set<number>): { LF: number; LH: number } {
  let LF = 0;
  let LH = 0;
  for (const [line, count] of hits) {
    if (erased.has(line)) continue;
    LF++;
    if (count > 0) LH++;
  }
  return { LF, LH };
}
