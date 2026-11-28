/*
 * 카카오 애드핏 광고 + 광고 쿠키 안내 배너 (다위드 앱 공통 방식)
 * - 오른쪽 160x600 고정 배너: 1280px 이상, 화면 오른쪽 20px·세로 중앙. 표시 중 body 오른쪽 196px 여백
 * - 하단 배너: 푸터 바로 위 가운데. 768px 이상 300x250, 그 미만 320x100
 * - 쿠키 거부(localStorage privacy-consent = rejected) 시 광고를 불러오지 않음
 * - 미송출(data-ad-onfail) 시 해당 영역을 접어 빈 박스가 남지 않음
 */
(function () {
  var CONSENT_KEY = 'privacy-consent';
  var RAIL = { unit: 'DAN-BQRrqGdHhmBhbuXq', w: 160, h: 600 };
  var BOTTOM_DESKTOP = { unit: 'DAN-aeVJzhVt2ddWb3gc', w: 300, h: 250 };
  var BOTTOM_MOBILE = { unit: 'DAN-9DsCPTUW27REULxj', w: 320, h: 100 };

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function saveConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* 저장 실패는 무시 */ }
  }

  var style = document.createElement('style');
  style.textContent = [
    '.dw-ad-rail{position:fixed;right:20px;top:50%;transform:translateY(-50%);z-index:40;width:160px;min-height:600px}',
    'body.dw-has-ad-rail{padding-right:196px;box-sizing:border-box}',
    '.dw-ad-bottom{display:flex;justify-content:center;align-items:center;overflow:hidden;margin:32px clamp(16px,5vw,76px) 24px}',
    '.dw-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9998;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;max-width:760px;margin:0 auto;padding:14px 18px;border:1px solid #d6e0d8;border-radius:14px;background:#fff;box-shadow:0 10px 30px rgba(22,61,46,.14);color:#4a5f52;font-size:14px;line-height:1.6}',
    '.dw-consent p{margin:0;flex:1 1 320px}',
    '.dw-consent a{color:#287354}',
    '.dw-consent-actions{display:flex;gap:8px;flex:0 0 auto}',
    '.dw-consent button{padding:7px 14px;border-radius:8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
    '.dw-consent .dw-reject{border:1px solid #cbd8ce;background:#fff;color:#4a5f52}',
    '.dw-consent .dw-accept{border:1px solid #1b5c43;background:#1b5c43;color:#fff}'
  ].join('\n');
  document.head.appendChild(style);

  var mounted = [];

  function makeSlot(container, ad, onFail) {
    var failName = 'dwAdFail_' + ad.unit.replace(/[^A-Za-z0-9]/g, '');
    window[failName] = onFail;
    var ins = document.createElement('ins');
    ins.className = 'kakao_ad_area';
    ins.style.display = 'none';
    ins.setAttribute('data-ad-unit', ad.unit);
    ins.setAttribute('data-ad-width', String(ad.w));
    ins.setAttribute('data-ad-height', String(ad.h));
    ins.setAttribute('data-ad-onfail', failName);
    container.appendChild(ins);
  }

  function removeRail(rail) {
    rail.remove();
    document.body.classList.remove('dw-has-ad-rail');
  }

  function mountAds() {
    var footer = document.querySelector('.site-footer');

    if (window.matchMedia('(min-width: 1280px)').matches) {
      var rail = document.createElement('div');
      rail.className = 'dw-ad-rail';
      rail.setAttribute('aria-label', '광고');
      document.body.appendChild(rail);
      document.body.classList.add('dw-has-ad-rail');
      makeSlot(rail, RAIL, function () { removeRail(rail); });
      mounted.push(function () { removeRail(rail); });
    }

    if (footer && footer.parentNode) {
      var bottomAd = window.matchMedia('(min-width: 768px)').matches ? BOTTOM_DESKTOP : BOTTOM_MOBILE;
      var bottom = document.createElement('div');
      bottom.className = 'dw-ad-bottom';
      bottom.setAttribute('aria-label', '광고');
      bottom.style.minHeight = bottomAd.h + 'px';
      footer.parentNode.insertBefore(bottom, footer);
      makeSlot(bottom, bottomAd, function () { bottom.remove(); });
      mounted.push(function () { bottom.remove(); });
    }

    if (mounted.length) {
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://t1.kakaocdn.net/kas/static/ba.min.js';
      document.body.appendChild(script);
    }
  }

  function showConsentBanner() {
    var banner = document.createElement('div');
    banner.className = 'dw-consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', '광고 쿠키 안내');
    banner.innerHTML =
      '<p>이 사이트는 카카오 애드핏 광고를 싣고, 광고에 쿠키가 쓰일 수 있어요. ' +
      '<a href="./privacy.html#cookies">자세히 보기</a></p>' +
      '<div class="dw-consent-actions">' +
      '<button type="button" class="dw-reject">광고 쿠키 거부</button>' +
      '<button type="button" class="dw-accept">확인했어요</button></div>';
    banner.querySelector('.dw-reject').addEventListener('click', function () {
      saveConsent('rejected');
      mounted.forEach(function (remove) { remove(); });
      mounted = [];
      banner.remove();
    });
    banner.querySelector('.dw-accept').addEventListener('click', function () {
      saveConsent('accepted');
      banner.remove();
    });
    document.body.appendChild(banner);
  }

  function init() {
    var consent = readConsent();
    if (consent !== 'rejected') mountAds();
    if (!consent) showConsentBanner();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
