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

// 2026~2027 주요 공휴일 목록 (평일이라도 주말처럼 전 시간대 감시하고 싶을 때 활용)
const KR_HOLIDAYS = new Set([
  '20261225', // 크리스마스
  '20270101', // 신정
  '20270206', '20270207', '20270208', '20270209', // 설날 연휴
  '20270301'  // 삼일절
]);

// 한국 시간(KST) 기준 조회할 날짜 리스트 생성
function getTargetDates(days = 25) {
  const dates = [];
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const currentYmd =
    `${kstNow.getUTCFullYear()}` +
    `${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(kstNow.getUTCDate()).padStart(2, '0')}`;
  const currentHm =
    `${String(kstNow.getUTCHours()).padStart(2, '0')}:` +
    `${String(kstNow.getUTCMinutes()).padStart(2, '0')}`;

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  for (let i = 0; i < days; i++) {
    const d = new Date(kstNow);
    d.setUTCDate(kstNow.getUTCDate() + i);

    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;
    const dayOfWeek = d.getUTCDay(); // 0: 일, 6: 토

    const isWeekendOrHoliday = dayOfWeek === 0 || dayOfWeek === 6 || KR_HOLIDAYS.has(dateStr);

    dates.push({
      dateStr,
      dateFormatted: `${yyyy}-${mm}-${dd}(${dayNames[dayOfWeek]})`,
      dayType: isWeekendOrHoliday ? (KR_HOLIDAYS.has(dateStr) ? '공휴일' : '주말') : '평일',
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

      // 1) 우리가 원하는 타겟 시간대인지 확인 (평일: 19:00, 주말: 전 시간대)
      if (!targetTimes.includes(startTime)) continue;

      // 2) 오늘 날짜인 경우 이미 시작 시간이 지난 타임은 제외
      if (isToday && startTime <= currentHm) continue;

      // 3) 빈자리 판별 핵심 로직:
      // 예약이 차 있으면 detail에 "홍길동(홍길동)"처럼 이름이 들어가고 use_yn이 "Y"가 됨.
      // 빈자리는 detail이 비어있거나("") use_yn이 "N"으로 내려옴.
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
  // 1. 보안용 Secret 검증
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 기본 25일 치 조회 (쿼리 파라미터 ?days=14 등으로 조절 가능)
  const daysToScan = parseInt(req.query.days || '25', 10);
  const targetDates = getTargetDates(daysToScan);

  // 2. 전체 (날짜 x 4개 코트) 작업 목록 생성
  const tasks = [];
  for (const dateInfo of targetDates) {
    for (const [placeCode, courtName] of Object.entries(COURTS)) {
      tasks.push(() => fetchCourtState(placeCode, courtName, dateInfo));
    }
  }

  // 강서구 서버 부하 방지를 위해 20개씩 배치(Batch) 병렬 실행 (총 1~2초 소요)
  const BATCH_SIZE = 20;
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

        // 이전에 알림을 보낸 적이 없는 새로운 빈자리만 발송 목록에 추가
        if (!notifiedCache.has(slotKey)) {
          notifiedCache.add(slotKey);
          newlyFound.push(slotInfo);
        }
      } else {
        // 누군가 예약해서 마감되면 캐시에서 제거 (나중에 다시 취소표가 나오면 재알림)
        notifiedCache.delete(slotKey);
      }
    }
  }

  // 3. 테스트 발송 옵션 (?test=1 붙여서 호출 시 강제로 작동 확인 메시지 전송)
  if (req.query.test === '1') {
    await sendTelegram(
      `✅ <b>[강서구립테니스장 알림 봇 정상 작동 중]</b>\n` +
      `• 스캔 기간: 향후 ${daysToScan}일 (${tasks.length}개 코트·날짜 조합)\n` +
      `• 현재 열려있는 타겟 빈자리: ${allCurrentlyOpen.length}건`
    );
  }

  // 4. 새로운 빈자리 발견 시 텔레그램 알림 발송
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
    scannedDays: daysToScan,
    totalApiCalls: tasks.length,
    currentlyOpenCount: allCurrentlyOpen.length,
    newAlertsSent: newlyFound.length,
    currentlyOpen: allCurrentlyOpen
  });
}
