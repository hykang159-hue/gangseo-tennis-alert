// 컨테이너 재사용(Warm start) 시 중복 알림을 막기 위한 인메모리 캐시
const notifiedCache = new Set();

// 감시할 코트 목록
const COURTS = {
  3: '3코트',
  4: '4코트',
  5: '5코트',
  6: '6코트(연습가능)'
};

// 평일 및 주말 타겟 시작 시간 (start_time 기준)
const WEEKDAY_TIMES = ['19:00'];
const WEEKEND_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'];

// 2026~2027 주요 공휴일 목록
const KR_HOLIDAYS = new Set([
  '20261225', // 크리스마스
  '20270101', // 신정
  '20270206', '20270207', '20270208', '20270209', // 설날 연휴
  '20270301'  // 삼일절
]);

// 특정 연/월의 '3번째 화요일' 날짜(일)를 구하는 함수
function getThirdTuesdayDate(year, monthIndex) {
  // 해당 월 1일의 요일 (0: 일, 1: 월, 2: 화, ..., 6: 토)
  const firstDayOfWeek = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  // 첫 번째 화요일(2)까지의 날짜 차이 계산
  const offsetToFirstTuesday = (2 - firstDayOfWeek + 7) % 7;
  const firstTuesday = 1 + offsetToFirstTuesday;
  // 3번째 화요일 = 첫 번째 화요일 + 14일
  return firstTuesday + 14;
}

// 한국 시간(KST) 기준 조회할 날짜 리스트 자동 생성
function getSmartTargetDates(overrideDays = null) {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth(); // 0(1월) ~ 11(12월)
  const date = kstNow.getUTCDate();
  const hours = kstNow.getUTCHours();
  const minutes = kstNow.getUTCMinutes();

  const currentYmd =
    `${year}` +
    `${String(month + 1).padStart(2, '0')}` +
    `${String(date).padStart(2, '0')}`;
  const currentHm =
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}`;

  let endDateUtc;

  // 1) 만약 URL에 ?days=N 파라미터를 수동으로 넣었다면 해당 일수만큼 조회
  if (overrideDays) {
    endDateUtc = new Date(Date.UTC(year, month, date + overrideDays - 1));
  } else {
    // 2) 자동 계산: 이번 달 3번째 화요일 오전 9시 경과 여부 확인
    const thirdTuesday = getThirdTuesdayDate(year, month);
    const isNextMonthOpened =
      date > thirdTuesday || (date === thirdTuesday && hours >= 9);

    if (isNextMonthOpened) {
      // 3번째 화요일 09:00 이후 -> 다음 달 말일까지 스캔 (month + 2의 0번째 날 = 다음 달 말일)
      endDateUtc = new Date(Date.UTC(year, month + 2, 0));
    } else {
      // 3번째 화요일 09:00 이전 -> 이번 달 말일까지만 스캔 (month + 1의 0번째 날 = 이번 달 말일)
      endDateUtc = new Date(Date.UTC(year, month + 1, 0));
    }
  }

  const dates = [];
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const startUtc = new Date(Date.UTC(year, month, date));

  for (
    let d = new Date(startUtc);
    d <= endDateUtc;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;
    const dayOfWeek = d.getUTCDay();

    const isWeekendOrHoliday =
      dayOfWeek === 0 || dayOfWeek === 6 || KR_HOLIDAYS.has(dateStr);

    dates.push({
      dateStr,
      dateFormatted: `${yyyy}-${mm}-${dd}(${dayNames[dayOfWeek]})`,
      dayType: isWeekendOrHoliday
        ? KR_HOLIDAYS.has(dateStr)
          ? '공휴일'
          : '주말'
        : '평일',
      targetTimes: isWeekendOrHoliday ? WEEKEND_TIMES : WEEKDAY_TIMES,
      isToday: dateStr === currentYmd,
      currentHm
    });
  }

  return dates;
}

// 텔레그램 메시지 발송 함수
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
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

// 단일 (날짜 + 코트) JSON API 호출
async function fetchCourtState(placeCode, courtName, dateInfo) {
  const { dateStr, targetTimes, isToday, currentHm } = dateInfo;

  const apiUrl =
    `https://sports.gangseo.seoul.kr/rest/facilities/place_time_state_list` +
    `?company_code=GANGSEO03&part_code=02&place_code=${placeCode}` +
    `&base_date=${dateStr}&rent_type=1001&mem_no=&_=${Date.now()}`;

  const bookingUrl =
    `https://sports.gangseo.seoul.kr/fmcs/28` +
    `?facilities_type=C&base_date=${dateStr}` +
    `&rent_type=1001&center=GANGSEO03&part=02&place=${placeCode}#regist_list`;

  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': bookingUrl
      }
    });

    if (!res.ok) return { placeCode, courtName, dateInfo, bookingUrl, openSlots: [] };

    const list = await res.json();
    if (!Array.isArray(list)) return { placeCode, courtName, dateInfo, bookingUrl, openSlots: [] };

    const openSlots = [];

    for (const item of list) {
      const startTime = (item.start_time || '').trim();
      const endTime = (item.end_time || '').trim();
      const timeNm = (item.time_nm || '').trim();
      const useYn = String(item.use_yn || '').trim().toUpperCase();
      const detail = String(item.detail || '').trim();

      if (!targetTimes.includes(startTime)) continue;
      if (isToday && startTime <= currentHm) continue;

      const isAvailable = (detail === '' || useYn === 'N');

      if (isAvailable) {
        openSlots.push({
          startTime,
          endTime,
          timeNm
        });
      }
    }

    return { placeCode, courtName, dateInfo, bookingUrl, openSlots };
  } catch (err) {
    console.error(`[ 조회 오류 ] ${dateStr} ${courtName}:`, err.message);
    return { placeCode, courtName, dateInfo, bookingUrl, openSlots: [] };
  }
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ?days 파라미터가 없으면 매월 3번째 화요일 09시 기준 자동 계산
  const overrideDays = req.query.days ? parseInt(req.query.days, 10) : null;
  const targetDates = getSmartTargetDates(overrideDays);

  const tasks = [];
  for (const dateInfo of targetDates) {
    for (const [placeCode, courtName] of Object.entries(COURTS)) {
      tasks.push(() => fetchCourtState(placeCode, courtName, dateInfo));
    }
  }

  const BATCH_SIZE = 25;
  const results = [];
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const chunk = tasks.slice(i, i + BATCH_SIZE).map((fn) => fn());
    const chunkRes = await Promise.all(chunk);
    results.push(...chunkRes);
  }

  const newlyFound = [];
  const allCurrentlyOpen = [];

  for (const item of results) {
    const { placeCode, courtName, dateInfo, bookingUrl, openSlots } = item;
    const openStartTimes = new Set(openSlots.map((s) => s.startTime));

    for (const tTime of dateInfo.targetTimes) {
      const slotKey = `${dateInfo.dateStr}_${placeCode}_${tTime}`;

      if (openStartTimes.has(tTime)) {
        const slotDetail = openSlots.find((s) => s.startTime === tTime);
        const slotInfo = {
          dateFormatted: dateInfo.dateFormatted,
          dayType: dateInfo.dayType,
          courtName,
          timeRange: `${slotDetail.startTime}~${slotDetail.endTime} (${slotDetail.timeNm})`,
          bookingUrl
        };
        allCurrentlyOpen.push(slotInfo);

        if (!notifiedCache.has(slotKey)) {
          notifiedCache.add(slotKey);
          newlyFound.push(slotInfo);
        }
      } else {
        notifiedCache.delete(slotKey);
      }
    }
  }

  const scanRangeText =
    targetDates.length > 0
      ? `${targetDates[0].dateFormatted} ~ ${targetDates[targetDates.length - 1].dateFormatted} (${targetDates.length}일간)`
      : '없음';

  if (req.query.test === '1') {
    await sendTelegram(
      `✅ <b>[강서구립테니스장 알림 봇 정상 작동 중]</b>\n` +
      `• 자동 스캔 범위: ${scanRangeText}\n` +
      `• 현재 열려있는 타겟 빈자리: ${allCurrentlyOpen.length}건`
    );
  }

  if (newlyFound.length > 0) {
    const lines = newlyFound.map(
      (s) =>
        `• <b>${s.dateFormatted} [${s.dayType}]</b>\n` +
        `  🏟 <b>${s.courtName}</b> | ⏰ ${s.timeRange}\n` +
        `  👉 <a href="${s.bookingUrl}">예약 페이지 바로가기</a>`
    );

    const message =
      `🎾 <b>[강서구립테니스장 빈자리 발생!]</b>\n\n` +
      lines.join('\n\n');

    await sendTelegram(message);
  }

  return res.status(200).json({
    ok: true,
    scanRange: scanRangeText,
    scannedDays: targetDates.length,
    totalApiCalls: tasks.length,
    currentlyOpenCount: allCurrentlyOpen.length,
    newAlertsSent: newlyFound.length,
    currentlyOpen: allCurrentlyOpen
  });
}
