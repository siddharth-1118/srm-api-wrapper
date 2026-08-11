import * as cheerio from 'cheerio';

export interface GradeCourse {
  code: string | null;
  name: string | null;
  internalMarks: number | null;
  externalMarks: number | null;
  totalMarks: number | null;
  grade: string | null;
  gradePoint: number | null;
  credits: number | null;
  status: string | null;
  courseType: string | null;
  _raw: Record<string, string>; // preserves all columns
}

export interface SemesterSummary {
  totalCredits: number | null;
  sgpa: number | null;
  cgpa: number | null;
  gpa: number | null;
}

export interface ParsedSemesterGrades {
  semester: string | null;
  academicYear: string | null;
  courses: GradeCourse[];
  summary: SemesterSummary;
  _rawHeaders: string[];
}

const GRADE_MATCHERS = {
  code: ['subject code', 'course code', 'code', 'paper code', 'sub code', 'slno', 'sl.no', 'sno'],
  name: ['subject name', 'subject', 'course name', 'description', 'title', 'paper name', 'subject title', 'course title'],
  internalMarks: ['internal', 'int', 'internal mark', 'internal marks', 'cia'],
  externalMarks: ['external', 'ext', 'external mark', 'external marks', 'university exam', 'ese'],
  totalMarks: ['total', 'total mark', 'total marks', 'marks', 'tot'],
  grade: ['grade', 'letter grade', 'result', 'grade awarded', 'final grade'],
  gradePoint: ['grade point', 'grade points', 'gp', 'points'],
  credits: ['credit', 'credits', 'cr', 'total credits', 'subject credit'],
  status: ['status', 'remarks', 'remark', 'eligibility', 'result status', 'pass/fail', 'result'],
  courseType: ['course type', 'type', 'category', 'theory/lab', 'lab/theory'],
};

function matchColumn(header: string, keys: string[]): boolean {
  const h = header.toLowerCase().trim();
  return keys.some(k => h.includes(k));
}

function scoreGradeTable(headers: string[]): number {
  let score = 0;
  for (const header of headers) {
    if (matchColumn(header, GRADE_MATCHERS.grade)) score += 3;
    if (matchColumn(header, GRADE_MATCHERS.code)) score += 2;
    if (matchColumn(header, GRADE_MATCHERS.name)) score += 2;
    if (matchColumn(header, GRADE_MATCHERS.credits)) score += 2;
    if (matchColumn(header, GRADE_MATCHERS.totalMarks)) score += 1;
    if (matchColumn(header, GRADE_MATCHERS.internalMarks)) score += 1;
    if (matchColumn(header, GRADE_MATCHERS.externalMarks)) score += 1;
  }
  return score;
}

function toNum(val: string | null | undefined): number | null {
  if (val === undefined || val === null || val.trim() === '') return null;
  const clean = val.replace(/[^0-9.]/g, '');
  if (clean === '') return null;
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

export function parseGradePage(html: string): ParsedSemesterGrades {
  const $ = cheerio.load(html);

  // ── Step 1: Find all tables ──────────────────────────────────────────────
  const tables: Array<{ headers: string[]; rows: Record<string, string>[] }> = [];

  $('table').each((_, tableEl) => {
    const headers: string[] = [];
    const rows: Record<string, string>[] = [];

    let headerRow = $(tableEl).find('thead tr').first();
    if (!headerRow.length) headerRow = $(tableEl).find('tr').first();

    headerRow.find('th, td').each((_, cell) => {
      headers.push($(cell).text().trim().replace(/\s+/g, ' '));
    });

    $(tableEl).find('tbody tr, tr').each((rowIdx, trEl) => {
      if (rowIdx === 0 && !$(tableEl).find('thead').length) return;
      const cells = $(trEl).find('td');
      if (cells.length === 0) return;

      const row: Record<string, string> = {};
      cells.each((cellIdx, cellEl) => {
        const key = headers[cellIdx] || `col_${cellIdx}`;
        row[key] = $(cellEl).text().trim().replace(/\s+/g, ' ');
      });

      if (Object.values(row).some(v => v.length > 0)) {
        rows.push(row);
      }
    });

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows });
    }
  });

  // ── Step 2: Score tables and pick best grade table ────────────────────────
  let bestScore = -1;
  let bestTableIdx = -1;
  tables.forEach((t, i) => {
    const score = scoreGradeTable(t.headers);
    if (score > bestScore) {
      bestScore = score;
      bestTableIdx = i;
    }
  });

  const gradeTable = bestTableIdx >= 0 ? tables[bestTableIdx] : null;

  // ── Step 3: Extract Label-Value Pairs for Summary / Metadata ─────────────
  const labelValues: Record<string, string> = {};
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td, th');
    if (tds.length >= 2) {
      const k = tds.eq(0).text().trim().toLowerCase().replace(/:$/, '');
      const v = tds.eq(1).text().trim();
      if (k && v && k.length < 60) labelValues[k] = v;
    }
  });

  // Check any divs/spans containing CGPA/SGPA
  const pageText = $('body').text().replace(/\s+/g, ' ');
  const sgpaMatch = pageText.match(/[Ss][Gg][Pp][Aa][:\s]+([0-9.]+)/);
  const cgpaMatch = pageText.match(/[Cc][Gg][Pp][Aa][:\s]+([0-9.]+)/);
  const creditMatch = pageText.match(/(?:[Cc]redits|[Cc]redit\s+[Ee]arned)[:\s]+([0-9]+)/);

  const getLabelValue = (keys: string[]): string | null => {
    const found = Object.entries(labelValues).find(([k]) => keys.some(kw => k.includes(kw)));
    return found ? found[1] : null;
  };

  const totalCredits = toNum(getLabelValue(['total credits', 'credits earned', 'earned credits', 'registered credits'])) || (creditMatch ? toNum(creditMatch[1]) : null);
  const sgpa = toNum(getLabelValue(['sgpa', 'semester gpa', 'sem gpa'])) || (sgpaMatch ? toNum(sgpaMatch[1]) : null);
  const cgpa = toNum(getLabelValue(['cgpa', 'cumulative gpa'])) || (cgpaMatch ? toNum(cgpaMatch[1]) : null);

  const semesterMatch = pageText.match(/[Ss]emester[:\s]+([A-Za-z0-9_]+)/);
  const yearMatch = pageText.match(/[Aa]cademic\s+[Yy]ear[:\s]+([0-9\-]+)/);

  const semester = getLabelValue(['semester', 'sem']) || (semesterMatch ? semesterMatch[1] : null);
  const academicYear = getLabelValue(['academic year', 'year', 'session']) || (yearMatch ? yearMatch[1] : null);

  // ── Step 4: Map rows to courses ──────────────────────────────────────────
  const courses: GradeCourse[] = [];
  if (gradeTable) {
    const headers = gradeTable.headers;

    const colMap: Record<keyof typeof GRADE_MATCHERS, number | null> = {
      code: null, name: null, internalMarks: null, externalMarks: null,
      totalMarks: null, grade: null, gradePoint: null, credits: null,
      status: null, courseType: null,
    };

    headers.forEach((h, idx) => {
      let bestField: keyof typeof GRADE_MATCHERS | null = null;
      let bestMatchLength = -1;

      for (const [field, keys] of Object.entries(GRADE_MATCHERS)) {
        for (const key of keys) {
          const lowerH = h.toLowerCase().trim();
          if (lowerH === key) {
            bestField = field as keyof typeof GRADE_MATCHERS;
            bestMatchLength = key.length + 1000;
            break;
          } else if (lowerH.includes(key)) {
            if (key.length > bestMatchLength) {
              bestField = field as keyof typeof GRADE_MATCHERS;
              bestMatchLength = key.length;
            }
          }
        }
      }

      if (bestField && colMap[bestField] === null) {
        colMap[bestField] = idx;
      }
    });

    for (const row of gradeTable.rows) {
      const getCol = (field: keyof typeof GRADE_MATCHERS): string | undefined => {
        const idx = colMap[field];
        if (idx === null) return undefined;
        const key = headers[idx];
        return key ? row[key] : undefined;
      };

      const code = getCol('code');
      const name = getCol('name');
      if (!code && !name) continue;

      // Skip repeated header rows
      const codeHeader = colMap.code !== null ? headers[colMap.code] : null;
      if (code && codeHeader && code === codeHeader) continue;

      const codeLower = (code || '').toLowerCase();
      if (codeLower === 'total' || codeLower === 'overall' || codeLower === 's.no' || codeLower === 'sl.no') continue;

      // Gather additional fields
      const additionalFields: Record<string, string> = {};
      Object.entries(row).forEach(([k, v]) => {
        const lowerK = k.toLowerCase();
        const isStandard = Object.keys(GRADE_MATCHERS).some(field => lowerK.includes(field));
        if (!isStandard) additionalFields[k] = v;
      });

      courses.push({
        code: code || null,
        name: name || null,
        internalMarks: toNum(getCol('internalMarks')),
        externalMarks: toNum(getCol('externalMarks')),
        totalMarks: toNum(getCol('totalMarks')),
        grade: getCol('grade') || null,
        gradePoint: toNum(getCol('gradePoint')),
        credits: toNum(getCol('credits')),
        status: getCol('status') || null,
        courseType: getCol('courseType') || null,
        _raw: row,
      });
    }
  }

  return {
    semester: semester || '1',
    academicYear,
    courses,
    summary: {
      totalCredits,
      sgpa,
      cgpa,
      gpa: sgpa,
    },
    _rawHeaders: gradeTable?.headers ?? [],
  };
}
