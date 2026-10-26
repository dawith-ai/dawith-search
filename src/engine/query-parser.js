/**
 * Dawith Search - Query Parser & Matcher Engine
 * Fully compatible with Voidtools Everything syntax + AI Natural Language Queries
 */

const EXTENSION_CATEGORIES = {
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'alac', 'mid', 'midi'],
  zip: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab', 'jar'],
  compressed: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab', 'jar'],
  doc: ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'hwpx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'md'],
  document: ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'hwpx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'md'],
  exe: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'vbs', 'reg', 'app'],
  executable: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'com', 'vbs', 'reg', 'app'],
  folder: [],
  directory: [],
  pic: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  picture: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'raw', 'psd', 'ai'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts', 'mts']
};

const SIZE_PRESETS = {
  empty: [0, 0],
  tiny: [0, 10 * 1024],
  small: [10 * 1024, 100 * 1024],
  medium: [100 * 1024, 1024 * 1024],
  large: [1024 * 1024, 16 * 1024 * 1024],
  huge: [16 * 1024 * 1024, 128 * 1024 * 1024],
  gigantic: [128 * 1024 * 1024, Infinity]
};

function parseSizeUnit(str) {
  if (!str) return 0;
  const match = str.trim().toLowerCase().match(/^([<>=]*)\s*([0-9.]+)\s*(kb|mb|gb|tb|b)?$/);
  if (!match) return null;
  const op = match[1] || '=';
  const val = parseFloat(match[2]);
  const unit = match[3] || 'b';
  let bytes = val;
  if (unit === 'kb') bytes = val * 1024;
  else if (unit === 'mb') bytes = val * 1024 * 1024;
  else if (unit === 'gb') bytes = val * 1024 * 1024 * 1024;
  else if (unit === 'tb') bytes = val * 1024 * 1024 * 1024 * 1024;
  return { op, bytes };
}

function parseDateCondition(str) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  const lower = str.toLowerCase().trim();
  let op = '=';
  let target = lower;

  if (target.startsWith('>=')) { op = '>='; target = target.slice(2).trim(); }
  else if (target.startsWith('<=')) { op = '<='; target = target.slice(2).trim(); }
  else if (target.startsWith('>')) { op = '>'; target = target.slice(1).trim(); }
  else if (target.startsWith('<')) { op = '<'; target = target.slice(1).trim(); }

  // Relative presets
  if (target === 'today' || target === '오늘') {
    return { op: op === '=' ? '>=' : op, time: today };
  }
  if (target === 'yesterday' || target === '어제') {
    return { op: op === '=' ? '>=' : op, time: today - oneDay };
  }
  if (target === 'thisweek' || target === '이번주') {
    const dayOfWeek = now.getDay();
    return { op: op === '=' ? '>=' : op, time: today - dayOfWeek * oneDay };
  }
  if (target === 'lastweek' || target === '지난주') {
    return { op: op === '=' ? '>=' : op, time: today - 7 * oneDay };
  }
  if (target === 'thismonth' || target === '이번달') {
    return { op: op === '=' ? '>=' : op, time: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
  }
  if (target === 'lastmonth' || target === '지난달') {
    return { op: op === '=' ? '>=' : op, time: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() };
  }
  if (target === 'thisyear' || target === '올해') {
    return { op: op === '=' ? '>=' : op, time: new Date(now.getFullYear(), 0, 1).getTime() };
  }

  // Relative days: today-7d, 7d
  const relMatch = target.match(/^today-(\d+)(d|days?|일)?$/) || target.match(/^(\d+)(d|days?|일)전?$/);
  if (relMatch) {
    const days = parseInt(relMatch[1], 10);
    return { op: op === '=' ? '>=' : op, time: today - days * oneDay };
  }

  // ISO date: YYYY-MM-DD
  const parsed = Date.parse(target);
  if (!isNaN(parsed)) {
    return { op, time: parsed };
  }
  return null;
}

/**
 * Natural Language Parser for AI Smart Search
 * Translates Korean/English intuitive queries to Everything syntax
 */
function translateNaturalLanguage(raw) {
  let query = raw.trim();

  // "100MB 이상 동영상" -> size:>100mb video:
  // "어제 다운로드한 pdf" -> dm:yesterday ext:pdf
  // "지난주 작성한 엑셀 파일" -> dm:lastweek ext:xlsx,xls
  // "사진 중 바다" -> pic: 바다
  const patterns = [
    { regex: /(?:최근|지난주|지난 주)\s*(?:에\s*)?(?:작성|수정|다운로드)?/g, replace: 'dm:lastweek ' },
    { regex: /(?:어제)\s*(?:에\s*)?(?:작성|수정|다운로드)?/g, replace: 'dm:yesterday ' },
    { regex: /(?:오늘)\s*(?:에\s*)?(?:작성|수정|다운로드)?/g, replace: 'dm:today ' },
    { regex: /(\d+)\s*(mb|gb|kb)\s*(?:이상|넘는|초과)/gi, replace: (m, value, unit) => `size:>${value}${unit} ` },
    { regex: /(\d+)\s*(mb|gb|kb)\s*(?:이하|미만)/gi, replace: (m, value, unit) => `size:<${value}${unit} ` },
    { regex: /(?:대용량 파일|큰 파일)/gi, replace: 'size:huge ' },
    { regex: /(?:중복\s*파일|중복된\s*파일)/gi, replace: 'dupe:name ' },
    { regex: /(?:동영상|비디오|영상)/gi, replace: 'video: ' },
    { regex: /(?:사진|이미지|포토)/gi, replace: 'pic: ' },
    { regex: /(?:음악|오디오|노래|mp3)/gi, replace: 'audio: ' },
    { regex: /(?:문서|보고서|문서들)/gi, replace: 'doc: ' },
    { regex: /(?:엑셀|스프레드시트)/gi, replace: 'ext:xlsx,xls ' },
    { regex: /(?:워드|한글문서)/gi, replace: 'ext:doc,docx,hwp,hwpx ' },
    { regex: /(?:pdf문서|pdf 파일)/gi, replace: 'ext:pdf ' },
    { regex: /(?:압축\s*파일|압축파일)/gi, replace: 'zip: ' },
    { regex: /(?:실행\s*파일|설치\s*파일)/gi, replace: 'exe: ' },
    { regex: /(?:폴더만|디렉토리만)/gi, replace: 'folder: ' }
  ];

  for (const p of patterns) {
    if (typeof p.replace === 'function') {
      query = query.replace(p.regex, p.replace);
    } else {
      query = query.replace(p.regex, p.replace);
    }
  }

  return query.replace(/\s+/g, ' ').trim();
}

/**
 * Compile a wildcard glob (* and ?) into regex
 */
function wildcardToRegex(pattern, caseSensitive = false) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(escaped, caseSensitive ? '' : 'i');
}

/**
 * Main Query Parser
 */
class QueryParser {
  static parse(queryString, options = {}) {
    let raw = queryString ? queryString.trim() : '';
    if (options.useAI || options.naturalLanguage) {
      raw = translateNaturalLanguage(raw);
    }

    if (!raw) {
      return { isEmpty: true, raw: '' };
    }

    const filters = {
      raw,
      caseSensitive: false,
      wholeWord: false,
      matchPath: false,
      regex: null,
      extensions: [],
      type: 'all', // 'all', 'file', 'folder'
      sizeConditions: [],
      dateModifiedConditions: [],
      dateCreatedConditions: [],
      depth: null,
      dupe: null, // 'name', 'size'
      content: null,
      tags: [],
      starred: null,
      terms: [] // array of AND term clauses
    };

    // Tokenize preserving quoted strings and parentheses
    const tokens = [];
    let currentToken = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if ((char === '"' || char === "'") && (!i || raw[i - 1] !== '\\')) {
        if (inQuotes && quoteChar === char) {
          inQuotes = false;
          quoteChar = '';
        } else if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        }
        currentToken += char;
      } else if (char === ' ' && !inQuotes) {
        if (currentToken.trim()) tokens.push(currentToken.trim());
        currentToken = '';
      } else {
        currentToken += char;
      }
    }
    if (currentToken.trim()) tokens.push(currentToken.trim());

    for (let token of tokens) {
      // Remove outer quotes or parentheses if present
      let cleanToken = token;
      if ((cleanToken.startsWith('"') && cleanToken.endsWith('"')) ||
          (cleanToken.startsWith("'") && cleanToken.endsWith("'"))) {
        cleanToken = cleanToken.slice(1, -1);
      }
      if (cleanToken.startsWith('(') && cleanToken.endsWith(')')) {
        cleanToken = cleanToken.slice(1, -1);
      } else {
        cleanToken = cleanToken.replace(/^\(+/, '').replace(/\)+$/, '');
      }

      const lower = cleanToken.toLowerCase();

      // Category macros
      if (lower === 'folder:' || lower === 'dir:') {
        filters.type = 'folder';
        continue;
      }
      if (lower === 'file:') {
        filters.type = 'file';
        continue;
      }
      if (EXTENSION_CATEGORIES[lower.replace(':', '')]) {
        const cat = lower.replace(':', '');
        if (cat === 'folder' || cat === 'directory') {
          filters.type = 'folder';
        } else {
          filters.extensions.push(...EXTENSION_CATEGORIES[cat]);
        }
        continue;
      }

      // Modifiers
      if (lower.startsWith('case:') || lower.startsWith('c:')) {
        filters.caseSensitive = true;
        cleanToken = cleanToken.replace(/^case:|^c:/i, '');
        if (!cleanToken) continue;
      }
      if (lower.startsWith('wholeword:') || lower.startsWith('ww:')) {
        filters.wholeWord = true;
        cleanToken = cleanToken.replace(/^wholeword:|^ww:/i, '');
        if (!cleanToken) continue;
      }
      if (lower.startsWith('path:') || lower.startsWith('p:')) {
        filters.matchPath = true;
        cleanToken = cleanToken.replace(/^path:|^p:/i, '');
        if (!cleanToken) continue;
      }
      if (lower.startsWith('regex:') || lower.startsWith('r:')) {
        const pattern = cleanToken.replace(/^regex:|^r:/i, '');
        try {
          filters.regex = new RegExp(pattern, filters.caseSensitive ? '' : 'i');
          continue;
        } catch (e) {
          // Treat malformed regex input as a literal search term.
          cleanToken = pattern;
        }
      }
      if (lower.startsWith('ext:')) {
        const exts = cleanToken.slice(4).split(/[,;]/).map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
        filters.extensions.push(...exts);
        continue;
      }
      if (lower.startsWith('size:')) {
        const val = cleanToken.slice(5).trim().toLowerCase();
        if (SIZE_PRESETS[val]) {
          const [min, max] = SIZE_PRESETS[val];
          filters.sizeConditions.push({ op: '>=', bytes: min });
          if (max !== Infinity) filters.sizeConditions.push({ op: '<=', bytes: max });
        } else {
          const parsed = parseSizeUnit(val);
          if (parsed) filters.sizeConditions.push(parsed);
        }
        continue;
      }
      if (lower.startsWith('dm:')) {
        const parsed = parseDateCondition(cleanToken.slice(3));
        if (parsed) filters.dateModifiedConditions.push(parsed);
        continue;
      }
      if (lower.startsWith('dc:')) {
        const parsed = parseDateCondition(cleanToken.slice(3));
        if (parsed) filters.dateCreatedConditions.push(parsed);
        continue;
      }
      if (lower.startsWith('depth:')) {
        const d = parseInt(cleanToken.slice(6), 10);
        if (!isNaN(d)) filters.depth = d;
        continue;
      }
      if (lower.startsWith('dupe:')) {
        filters.dupe = lower.slice(5).trim() || 'name';
        continue;
      }
      if (lower.startsWith('content:')) {
        filters.content = cleanToken.slice(8).trim();
        continue;
      }
      if (lower.startsWith('tag:')) {
        filters.tags.push(cleanToken.slice(4).trim());
        continue;
      }
      if (lower === 'starred:' || lower === 'star:') {
        filters.starred = true;
        continue;
      }

      // Check OR groups: e.g. "foo|bar|baz"
      const orParts = cleanToken.split('|').map(p => p.trim()).filter(Boolean);
      const orClauses = orParts.map(part => {
        let isNegated = false;
        if (part.startsWith('!') || part.startsWith('-')) {
          isNegated = true;
          part = part.slice(1).trim();
        }
        const hasWildcard = part.includes('*') || part.includes('?');
        return {
          text: part,
          isNegated,
          hasWildcard,
          regex: hasWildcard ? wildcardToRegex(part, filters.caseSensitive) : null
        };
      });

      filters.terms.push(orClauses);
    }

    return filters;
  }

  /**
   * Fast matcher evaluated against a file item
   * file item structure: { name, path, size, mtime, ctime, isDir, ext, tags, starred }
   */
  static matches(item, parsedFilters) {
    if (!parsedFilters || parsedFilters.isEmpty) return true;

    // Type filter
    if (parsedFilters.type === 'file' && item.isDir) return false;
    if (parsedFilters.type === 'folder' && !item.isDir) return false;

    // Extension filter
    if (parsedFilters.extensions.length > 0) {
      if (item.isDir) return false;
      if (!parsedFilters.extensions.includes(item.ext)) return false;
    }

    // Size filters apply to files only, matching Everything's file-size semantics.
    if (parsedFilters.sizeConditions.length > 0) {
      if (item.isDir) return false;
      for (const cond of parsedFilters.sizeConditions) {
        if (cond.op === '>' && !(item.size > cond.bytes)) return false;
        if (cond.op === '>=' && !(item.size >= cond.bytes)) return false;
        if (cond.op === '<' && !(item.size < cond.bytes)) return false;
        if (cond.op === '<=' && !(item.size <= cond.bytes)) return false;
        if (cond.op === '=' && !(item.size === cond.bytes)) return false;
      }
    }

    // Date modified filter
    if (parsedFilters.dateModifiedConditions.length > 0) {
      const mtime = item.mtime;
      for (const cond of parsedFilters.dateModifiedConditions) {
        if (cond.op === '>' && !(mtime > cond.time)) return false;
        if (cond.op === '>=' && !(mtime >= cond.time)) return false;
        if (cond.op === '<' && !(mtime < cond.time)) return false;
        if (cond.op === '<=' && !(mtime <= cond.time)) return false;
        if (cond.op === '=' && !(Math.abs(mtime - cond.time) < 86400000)) return false;
      }
    }

    // Date created filter
    if (parsedFilters.dateCreatedConditions.length > 0) {
      const ctime = item.ctime;
      for (const cond of parsedFilters.dateCreatedConditions) {
        if (cond.op === '>' && !(ctime > cond.time)) return false;
        if (cond.op === '>=' && !(ctime >= cond.time)) return false;
        if (cond.op === '<' && !(ctime < cond.time)) return false;
        if (cond.op === '<=' && !(ctime <= cond.time)) return false;
        if (cond.op === '=' && !(Math.abs(ctime - cond.time) < 86400000)) return false;
      }
    }

    // Depth filter
    if (parsedFilters.depth !== null) {
      const sep = item.path.includes('\\') ? '\\' : '/';
      const parts = item.path.split(sep).filter(Boolean);
      if (parts.length > parsedFilters.depth) return false;
    }

    // Starred filter
    if (parsedFilters.starred !== null && !!item.starred !== parsedFilters.starred) {
      return false;
    }

    // Tag filter
    if (parsedFilters.tags.length > 0) {
      if (!item.tags || !Array.isArray(item.tags)) return false;
      const lowerTags = item.tags.map(t => t.toLowerCase());
      for (const reqTag of parsedFilters.tags) {
        if (!lowerTags.includes(reqTag.toLowerCase())) return false;
      }
    }

    // Regex filter
    if (parsedFilters.regex) {
      const separator = item.path && item.path.includes('\\') ? '\\' : '/';
      const targetStr = parsedFilters.matchPath
        ? (item.path + (item.path.endsWith('\\') || item.path.endsWith('/') ? '' : separator) + item.name)
        : item.name;
      if (!parsedFilters.regex.test(targetStr)) return false;
    }

    // Terms (AND groups of OR clauses)
    const separator = item.path && item.path.includes('\\') ? '\\' : '/';
    const targetText = parsedFilters.matchPath
      ? (item.path + (item.path.endsWith('\\') || item.path.endsWith('/') ? '' : separator) + item.name)
      : item.name;
    const cmpTarget = parsedFilters.caseSensitive ? targetText : targetText.toLowerCase();

    for (const orClauses of parsedFilters.terms) {
      let matchedAnyOr = false;
      for (const clause of orClauses) {
        let isMatch = false;
        if (clause.hasWildcard && clause.regex) {
          isMatch = clause.regex.test(targetText);
        } else {
          const needle = parsedFilters.caseSensitive ? clause.text : clause.text.toLowerCase();
          if (parsedFilters.wholeWord) {
            const re = new RegExp(`\\b${needle.replace(/[.+^${}()|[\]\\]/g, '\\$&')}\\b`, parsedFilters.caseSensitive ? '' : 'i');
            isMatch = re.test(targetText);
          } else {
            isMatch = cmpTarget.includes(needle);
          }
        }

        if (clause.isNegated) {
          if (!isMatch) {
            matchedAnyOr = true;
            break;
          }
        } else {
          if (isMatch) {
            matchedAnyOr = true;
            break;
          }
        }
      }

      if (!matchedAnyOr) return false;
    }

    return true;
  }
}

module.exports = {
  QueryParser,
  EXTENSION_CATEGORIES,
  SIZE_PRESETS,
  translateNaturalLanguage
};
