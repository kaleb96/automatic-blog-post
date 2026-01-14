import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import Parser from 'rss-parser';

const parser = new Parser();

// 1. supabase 클라이언트 설정
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Gemini 설정
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FEEDS = [
  {
    category: 'AI-ML',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
  },
  {
    category: 'DEV',
    url: 'https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en',
  },
];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function generateContentWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      return result.candidates[0].content.parts[0].text;
    } catch (error) {
      if (error.message.includes('503') || error.message.includes('overloaded')) {
        const waitTime = 5000 * (i + 1);
        console.log(
          `[Overloaded] ${waitTime / 1000}초 후 다시 시도합니다... (${i + 1}/${retries})`,
        );
        await sleep(waitTime);
        continue;
      }
      throw error;
    }
  }
  throw new Error('최대 재시도 횟수를 초과했습니다.');
}
async function main() {
  console.log('뉴스 수집 및 분석 시작...');
  for (const feed of FEEDS) {
    const data = await parser.parseURL(feed.url);

    const topArticles = data.items.slice(0, 4);

    for (const article of topArticles) {
      // 1. DB 중복체크
      const { data: existingPost } = await supabase
        .from('news')
        .select('id')
        .eq('original_url', article.link)
        .single();

      if (existingPost) {
        console.log('중복 기사 스킵');
        continue;
      }

      console.log(`[Analyzing new article : ${article.title}]`);

      try {
        const prompt = `
당신은 기술적인 내용을 깔끔하게 정리하여 공유하는 주니어 개발자 '미어캣'입니다. 
제공된 기사를 바탕으로 인공지능이 생성한 자극적인 광고성 글이 아니라, 개발자가 직접 공부하고 핵심을 요약한 듯한 담백한 블로그 포스트를 작성하세요.

[지침]
1. 제목: 첫 줄에 [카테고리] 핵심 주제 형식을 사용하세요. (예: [DEV] 리액트 전략 분석)
2. 인사말: 제목 다음 줄에 "안녕하세요, 미어캣입니다."라고 작성하고 **반드시 한 줄을 비우세요**.
3. 마크다운 가독성: 
   - ### 헤더 뒤에는 무조건 한 줄을 비우세요.
   - 리스트 기호(* 혹은 -) 뒤에는 공백을 딱 한 칸만 두고 내용을 작성하세요.
   - 리스트 아이템 사이에는 개행을 넣어 간격을 벌리세요. (가독성 중요)
4. 본문 내용: 본문은 억지로 3파트로 나누지 말고, 내용의 흐름에 따라 최소 2개에서 최대 5개의 섹션으로 구성하세요.
    -  각 섹션의 시작은 '### 소제목' 형식을 사용하세요.
    - ### 헤더를 작성한 후에는 반드시 한 줄을 비우고(개행) 본문을 시작하세요. (예: ### 제목\\n\\n본문내용)
    - 문단 사이에도 충분한 개행을 두어 모바일에서도 읽기 편하게 만드세요.
5. 마무리 질문: "댓글로 의견 나누어 주세요" 대신, **"여러분은 이 기술의 변화가 우리의 개발 환경에 어떤 영향을 줄 것이라고 생각하시나요?"** 처럼 독자가 스스로 생각해보게 만드는 질문으로 끝내세요.
6. 톤앤매너: 
   - 친근하지만 가용한 지식을 전달하는 전문적인 말투 (~해요, ~입니다 체 혼용). 
   - "안녕하세요, 미어캣입니다." 인사 직후에는 반드시 한 줄 개행(\\n)을 하세요.
   - 자극적인 수식어(역대급, 충격, 세계 최초 등)와 AI 특유의 홍보용 문구(글로벌 테크, 독보적인 등)는 절대 사용 금지.
6. 출처 표기: 마지막에 "원문 출처: [기사제목](${article.link})"를 링크 없이 텍스트로만 기재하세요.

기사 제목: ${article.title}
기사 링크: ${article.link}
내용 요약: ${article.contentSnippet}
`;
        const fullText = await generateContentWithRetry(prompt);

        // 1. 줄 단위 분리 (빈 줄 유지)
        let lines = fullText.split('\n');

        // 2. 실제 내용이 시작되는 위치 찾기
        const firstContentIndex = lines.findIndex((l) => l.trim() !== '');

        // 3. 제목 추출 (첫 번째 내용 줄)
        // 만약 Gemini가 제목에 #을 붙였을 경우를 대비해 제거 로직 유지
        const rawTitle = lines[firstContentIndex] || '';
        const title = rawTitle.replace(/#|[*]/g, '').trim();

        // 4. 본문 가공 (제목 제외한 나머지)
        let content = lines
          .slice(firstContentIndex + 1)
          .join('\n')
          .trim();

        // [추가 보정] 마크다운 가독성 개선
        content = content
          // 리스트 기호 뒤에 과도한 공백(2칸 이상)이 있으면 1칸으로 줄임
          .replace(/^\s*[\*\-\+]\s{2,}/gm, '* ')
          // 소제목(###) 뒤에 개행이 하나뿐이라면 두 개로 늘려줌 (ReactMarkdown 렌더링 최적화)
          .replace(/### (.*)\n(?!\n)/g, '### $1\n\n');

        const { error: dbError } = await supabase.from('news').insert([
          {
            title,
            content,
            category: feed.category,
            original_url: article.link,
          },
        ]);

        if (dbError) throw dbError;
        console.log(`[Supabase saved success: TITLE: ${title}]`);
        await sleep(1000 * 60);
      } catch (error) {
        console.error(`[Unexpected Error : ${error.message}]`);
      }
    }
  }
}

main();
