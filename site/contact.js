/* contact.html: 문의 양식을 GitHub 새 이슈 주소로 바꿔 새 창에 엽니다. 서버로 보내는 것은 없습니다. */
(function (root) {
  'use strict';

  var ISSUE_URL = 'https://github.com/dawith-ai/dawith-search/issues/new';
  var MAX_URL_LENGTH = 6500; // GitHub은 약 7,000자를 넘는 주소를 거부합니다(500·414).

  function clean(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  }

  function oneLine(value) {
    return clean(value).replace(/\s+/g, ' ');
  }

  function buildIssueTitle(data) {
    return '[' + oneLine(data.type) + '] ' + oneLine(data.title);
  }

  function buildIssueBody(data) {
    var lines = ['- **문의 유형**: ' + oneLine(data.type), '- **작성자**: ' + oneLine(data.name)];
    if (oneLine(data.org)) lines.push('- **기관명**: ' + oneLine(data.org));
    if (oneLine(data.env)) lines.push('- **사용 환경**: ' + oneLine(data.env));
    lines.push('', '### 내용', '', clean(data.body), '', '---', '_Dawith Search 사이트 문의 양식에서 작성됨_');
    return lines.join('\n');
  }

  function buildIssueUrl(data) {
    return ISSUE_URL + '?title=' + encodeURIComponent(buildIssueTitle(data)) + '&body=' + encodeURIComponent(buildIssueBody(data));
  }

  // 공개 이슈에 올라가면 안 되는 정보가 보이면 막습니다.
  function findSensitive(text) {
    if (/\d{6}\s*-\s*[1-4]\d{6}/.test(text)) return '주민등록번호';
    if (/01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/.test(text) || /0\d{1,2}-\d{3,4}-\d{4}/.test(text)) return '전화번호';
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return '이메일 주소';
    return '';
  }

  function validate(data) {
    var errors = {};
    if (!oneLine(data.type)) errors.type = '문의 유형을 골라 주세요.';
    if (!oneLine(data.name)) errors.name = '이름이나 닉네임을 적어 주세요.';
    if (!oneLine(data.title)) errors.title = '제목을 적어 주세요.';
    else if (oneLine(data.title).length < 4) errors.title = '제목을 조금 더 구체적으로 적어 주세요. (4자 이상)';
    var body = clean(data.body);
    if (!body) errors.body = '문의 내용을 적어 주세요.';
    else if (body.length < 10) errors.body = '내용을 10자 이상 적어 주세요.';
    else if (body.length > 600) errors.body = '내용은 600자까지 쓸 수 있습니다.';
    if (!data.agree) errors.agree = '공개 등록에 동의해야 보낼 수 있습니다.';

    var fields = ['name', 'org', 'env', 'title', 'body'];
    for (var i = 0; i < fields.length; i++) {
      var kind = findSensitive(String(data[fields[i]] || ''));
      if (kind) {
        var key = fields[i] === 'org' || fields[i] === 'env' ? 'body' : fields[i];
        errors[key] = kind + '처럼 보이는 내용이 있습니다. GitHub 이슈는 공개되니 지우고 보내 주세요.';
        break;
      }
    }

    if (!Object.keys(errors).length && buildIssueUrl(data).length > MAX_URL_LENGTH) {
      errors.body = '내용이 너무 길어 GitHub로 넘길 수 없습니다. 조금 줄여 주세요.';
    }
    return errors;
  }

  var api = { buildIssueTitle: buildIssueTitle, buildIssueBody: buildIssueBody, buildIssueUrl: buildIssueUrl, validate: validate, findSensitive: findSensitive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document) return;

  function init() {
    var form = document.getElementById('contact-form');
    if (!form) return;
    var status = document.getElementById('ct-status');
    var bodyInput = document.getElementById('ct-body');
    var counter = document.getElementById('ct-body-count');
    var names = ['type', 'name', 'title', 'body', 'agree'];

    function read() {
      return {
        type: form.elements.type.value,
        name: form.elements.name.value,
        org: form.elements.org.value,
        env: form.elements.env.value,
        title: form.elements.title.value,
        body: form.elements.body.value,
        agree: form.elements.agree.checked
      };
    }

    function showErrors(errors) {
      var first = null;
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        var box = document.getElementById('ct-' + n + '-error');
        var input = form.elements[n];
        if (errors[n]) {
          box.textContent = errors[n];
          box.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', box.id);
          if (!first) first = input;
        } else {
          box.textContent = '';
          box.hidden = true;
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
        }
      }
      return first;
    }

    function setStatus(kind, html) {
      status.className = 'ct-status ' + kind;
      status.innerHTML = html;
      status.hidden = false;
    }

    function updateCount() {
      counter.textContent = bodyInput.value.length + ' / 600';
    }
    bodyInput.addEventListener('input', updateCount);
    updateCount();

    form.addEventListener('input', function (event) {
      var n = event.target.name;
      if (event.target.getAttribute('aria-invalid') && names.indexOf(n) !== -1) {
        var errors = validate(read());
        if (!errors[n]) showErrors(errors);
      }
    });
    form.addEventListener('change', function (event) {
      if (event.target.name === 'agree' && event.target.checked) {
        var box = document.getElementById('ct-agree-error');
        box.hidden = true;
        event.target.removeAttribute('aria-invalid');
      }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = read();
      var first = showErrors(validate(data));
      if (first) {
        status.hidden = true;
        first.focus();
        return;
      }
      var url = buildIssueUrl(data);
      // noopener로 열면 브라우저가 null을 돌려주기도 해서 팝업 차단 여부를 알 수 없습니다. 대체 링크를 늘 함께 보여 줍니다.
      root.open(url, '_blank', 'noopener');
      var link = '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">GitHub 이슈 작성 창 열기</a>';
      setStatus('ok', '<strong>GitHub 새 이슈 창을 열었습니다.</strong> 내용을 확인한 뒤 <b>Create</b>를 눌러야 등록됩니다. 창이 열리지 않았다면 ' + link + '을 눌러 주세요.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
