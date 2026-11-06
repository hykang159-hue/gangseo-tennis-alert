import * as cheerio from 'cheerio';

// 컨테이너 재사용(Warm start) 시 중복 발송을 막기 위한 인메모리 캐시
const notifiedCache = new Set();

// 코트 목록 (place 파라미터 : 코트명)
const COURTS = {
  3: '3코트',
  4: '4코트',
  5: '5코트',
  6: '6코트(연습가능)'
};

// 평일 및 주말 타겟 시간대 (2시간 단위 시작 시각 기준)
const WEEKDAY_TIMES = ['19:00'];
const WEEKEND_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'];

// 한국 시간(KST) 기준 날짜 리스트 생성 (오늘부터 N일간)
function getTargetDates(days = 14) {
  const dates = [];
  const now = new Date();
  // UTC -> KST 변환
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  for (let i = 0; i < days; i++) {
    const d = new Date(kstNow);
    d.setUTCDate(kstNow.getUTCDate() + i);

    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dayOfWeek = d.getUTCDay(); // 0: 일, 6: 토

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

    dates.push({
      dateStr: `${yyyy}${mm}${dd}`,
      dateFormatted: `${yyyy}-${mm}-${dd}(${dayNames[dayOfWeek]})`,
      isWeekend,
      targetTimes: isWeekend ? WEEKEND_TIMES : WEEKDAY_TIMES
    });
  }
  return dates;
}

// 텔레그램 메시지 발송
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

// 단일 (날짜 + 코트) 예약 현황 조회
async function checkCourtDate(placeId, courtName, dateInfo) {
  const { dateStr, dateFormatted, targetTimes } = dateInfo;

  // 사용자 직접 접속용 예약 링크
  const bookingUrl = `https://sports.gangseo.seoul.kr/fmcs/28?facilities_type=C&base_date=${dateStr}&rent_type=1001&center=GANGSEO03&part=02&place=${placeId}#regist_list`;

  // [핵심] FMCS 내부 시간표 조회 엔드포인트
  // 기본 URL은 FMCS 표준 AJAX 엔드포인트이며, 환경변수(FMCS_AJAX_URL)로 커스텀 가능
  const ajaxEndpoint =
    process.env.FMCS_AJAX_URL ||
    `https://sports.gangseo.seoul.kr/fmcs/28`;

  const queryParams = new URLSearchParams({
    facilities_type: 'C',
    base_date: dateStr,
    rent_type: '1001',
    center: 'GANGSEO03',
    part: '02',
    place: String(placeId),
    action: 'regist_list' // FMCS 시간표 모듈 액션 파라미터
  });

  try {
    const response = await fetch(`${ajaxEndpoint}?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': bookingUrl
      }
    });

    const contentType = response.headers.get('content-type') || '';
    const bodyText = await response.text();
    const foundSlots = [];

    // 1) 응답이 JSON 형태인 경우 (FMCS API 버전별 대응)
    if (contentType.includes('application/json') || bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
      const data = JSON.parse(bodyText);
      const list = Array.isArray(data) ? data : (data.list || data.data || data.result || []);

      for (const item of list) {
        const timeStr = item.start_time || item.time_name || item.rent_time || JSON.stringify(item);
        const stateStr = item.state_nm || item.status || item.rent_yn || JSON.stringify(item);

        for (const tTime of targetTimes) {
          if (timeStr.includes(tTime)) {
            const isAvailable =
              (stateStr.includes('가능') || stateStr.includes('신청') || item.rent_yn === 'Y' || item.available === true) &&
              !stateStr.includes('마감') &&
              !stateStr.includes('불가') &&
              !stateStr.includes('완료');

            if (isAvailable) {
              foundSlots.push(tTime);
            }
          }
        }
      }
    }
    // 2) 응답이 HTML 테이블 조각인 경우
    else {
      const $ = cheerio.load(bodyText);
      $('tr').each((_, el) => {
        const rowText = $(el).text().replace(/\s+/g, ' ').trim();
        if (!rowText) return;

        for (const tTime of targetTimes) {
          if (rowText.includes(tTime)) {
            const isAvailable =
              (rowText.includes('예약가능') || rowText.includes('신청') || rowText.includes('가능') || $(el).find('input[type="checkbox"]:not(:disabled)').length > 0) &&
              !rowText.includes('마감') &&
              !rowText.includes('완료') &&
              !rowText.includes('불가');

            if (isAvailable) {
              foundSlots.push(tTime);
            }
          }
        }
      });
    }

    return { placeId, courtName, dateInfo, bookingUrl, foundSlots };
  } catch (err) {
    console.error(`[Error] ${dateStr} - ${courtName}:`, err.message);
    return { placeId, courtName, dateInfo, bookingUrl, foundSlots: [] };
  }
}

export default async function handler(req, res) {
  // 1. 보안용 CRON_SECRET 검증 (아무나 URL을 호출하지 못하도록 방지)
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 조회할 일수 (쿼리 파라미터 ?days=7 로 조절 가능, 기본 10일)
  const daysToScan = parseInt(req.query.days || '10', 10);
  const targetDates = getTargetDates(daysToScan);

  // 2. 모든 (날짜 x 4개 코트) 조합 생성 및 병렬 조회
  const tasks = [];
  for (const dateInfo of targetDates) {
    for (const [placeId, courtName] of Object.entries(COURTS)) {
      tasks.push(checkCourtDate(placeId, courtName, dateInfo));
    }
  }

  const results = await Promise.all(tasks);
  const newlyFound = [];

  for (const item of results) {
    const { placeId, courtName, dateInfo, bookingUrl, foundSlots } = item;

    for (const tTime of dateInfo.targetTimes) {
      const slotKey = `${dateInfo.dateStr}_${placeId}_${tTime}`;

      if (foundSlots.includes(tTime)) {
        // 이전에 알림을 보낸 적 없는 슬롯만 발송 목록에 추가
        if (!notifiedCache.has(slotKey)) {
          notifiedCache.add(slotKey);
          newlyFound.push({
            dateFormatted: dateInfo.dateFormatted,
            courtName,
            time: `${tTime} ~ ${parseInt(tTime.split(':')[0], 10) + 2}:00`,
            bookingUrl
          });
        }
      } else {
        // 다시 마감되었으면 캐시에서 삭제 (다음에 취소표가 다시 나오면 재알림)
        notifiedCache.delete(slotKey);
      }
    }
  }

  // 3. 새로운 빈자리가 있으면 텔레그램 메시지 1개로 묶어서 전송
  if (newlyFound.length > 0) {
    const lines = newlyFound.map(
      (s) => `• <b>${s.dateFormatted}</b> | <b>${s.courtName}</b> | ${s.time}\n  👉 <a href="${s.bookingUrl}">바로 예약하기</a>`
    );
    const message =
      `🎾 <b>[강서구립테니스장 빈자리 발생!]</b>\n\n` +
      lines.join('\n\n');

    await sendTelegram(message);
  }

  return res.status(200).json({
    ok: true,
    scannedDates: daysToScan,
    totalChecks: tasks.length,
    newAlertsSent: newlyFound.length,
    newSlots: newlyFound
  });
}
