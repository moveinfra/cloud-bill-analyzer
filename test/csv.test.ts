import { describe, expect, it } from 'vitest';
import { CsvParser, parseCsv } from '../src/core/csv';

describe('CsvParser', () => {
  it('parses quotes, escaped quotes, commas and newlines inside fields', () => {
    expect(parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,"multi\nline",3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'he said "hi"'],
      ['2', 'multi\nline', '3'],
    ]);
  });

  it('handles CRLF, a BOM, a missing final newline and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', ''],
    ]);
  });

  it('gives the same rows however the input is chunked', () => {
    const text = 'h1,h2,h3\r\n"a ""q"" b",2,"x\r\ny"\n4,5,6\r\n';
    const whole = parseCsv(text);
    for (let size = 1; size <= 7; size++) {
      const rows: string[][] = [];
      const p = new CsvParser((r) => rows.push(r));
      for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
      p.end();
      expect(rows).toEqual(whole);
    }
  });

  it('keeps JSON in quoted fields intact', () => {
    const [, row] = parseCsv('a,info\n1,"{""ServiceType"":""Standard_D4s_v5""}"\n');
    expect(JSON.parse(row[1])).toEqual({ ServiceType: 'Standard_D4s_v5' });
  });
});
