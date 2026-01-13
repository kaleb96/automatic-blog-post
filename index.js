import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import Parser from "rss-parser";

const parser = new Parser();

// 1. supabase 클라이언트 설정
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 2. Gemini 설정
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FEEDS = [
  {
    category: "AI-ML",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    category: "DEV",
    url: "https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en",
  },
];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function generateContentWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return result.candidates[0].content.parts[0].text;
    } catch (error) {
      if (
        error.message.includes("503") ||
        error.message.includes("overloaded")
      ) {
        const waitTime = 5000 * (i + 1);
        console.log(
          `[Overloaded] ${waitTime / 1000}초 후 다시 시도합니다... (${
            i + 1
          }/${retries})`
        );
        await sleep(waitTime);
        continue;
      }
      throw error;
    }
  }
  throw new Error("최대 재시도 횟수를 초과했습니다.");
}
async function main() {
  console.log("뉴스 수집 및 분석 시작...");
  for (const feed of FEEDS) {
    const data = await parser.parseURL(feed.url);

    const topArticles = data.items.slice(0, 4);

    for (const article of topArticles) {
      // 1. DB 중복체크
      const { data: existingPost } = await supabase
        .from("news")
        .select("id")
        .eq("original_url", article.link)
        .single();

      if (existingPost) {
        console.log("중복 기사 스킵");
        continue;
      }

      console.log(`[Analyzing new article : ${article.title}]`);

      try {
        const prompt = `
당신은 기술적인 내용을 깔끔하게 정리하여 공유하는 주니어 개발자 '미어캣'입니다. 
제공된 기사를 바탕으로 인공지능이 생성한 자극적인 광고성 글이 아니라, 개발자가 직접 공부하고 핵심을 요약한 듯한 담백한 블로그 포스트를 작성하세요.

[지침]
1. 톤앤매너: 
   - 친근하지만 가용한 지식을 전달하는 전문적인 말투 (~해요, ~입니다 체 혼용). 
   - "안녕하세요, 미어캣입니다." 인사 직후에는 반드시 한 줄 개행(\\n)을 하세요.
   - 자극적인 수식어(역대급, 충격, 세계 최초 등)와 AI 특유의 홍보용 문구(글로벌 테크, 독보적인 등)는 절대 사용 금지.

2. 제목 형식: 
   - [카테고리] 핵심 주제를 담은 간결한 제목. (예: [DEV] 리액트의 새로운 상태 관리 전략 분석)
   - 제목에 불필요한 괄호나 특수문자는 사용하지 마세요.

3. 구성 및 마크다운 스타일 (ReactMarkdown 최적화):
   - **섹션 구분**: 본문은 억지로 3파트로 나누지 말고, 내용의 흐름에 따라 최소 2개에서 최대 4개의 섹션으로 구성하세요.
   - **헤더와 개행**: 
     - 각 섹션의 시작은 '### 소제목' 형식을 사용하세요.
     - ### 헤더를 작성한 후에는 반드시 한 줄을 비우고(개행) 본문을 시작하세요. (예: ### 제목\\n\\n본문내용)
     - 문단 사이에도 충분한 개행을 두어 모바일에서도 읽기 편하게 만드세요.
   - **가독성 기호**: 내용 정리 시 리스트 기호(☑, -, 1.)를 적극 활용하세요. 특히 핵심 특징은 '☑' 기호를 사용하면 좋습니다.

4. 사견 및 마무리: 
   - "개인적으로 이 소식을 접하며 ~라는 생각이 들었습니다."와 같이 개발자로서의 주관적인 견해와 한국 개발 생태계에 끼칠 영향을 1문단 포함하세요.
   - "여러분은 어떻게 생각하시나요? 댓글로 의견 나누어 주세요."로 끝맺음하세요.

5. 저작권 및 출처 표기:
   - 글의 가장 마지막에 두 줄 개행(\\n\\n)을 한 뒤, 아래 형식을 참고하여 출처를 명시하세요.
   - 형식: "본 포스팅은 외신 기사를 바탕으로 작성되었습니다. 원문 출처: [기사제목](${article.link})"

[기사 내용]
기사 제목: ${article.title}
기사 링크: ${article.link}
내용 요약: ${article.contentSnippet}

마크다운(Markdown) 형식으로 출력하세요.
`;
        const fullText = await generateContentWithRetry(prompt);

        // 1. 모든 줄을 나누되, 빈 줄을 삭제하지 않습니다.
        const lines = fullText.split("\n");

        // 2. 첫 번째 줄(제목) 찾기
        const titleIndex = lines.findIndex((l) => l.trim() !== "");
        const title = lines[titleIndex].replace(/#|[*]/g, "").trim();
        const content = lines
          .slice(titleIndex + 1)
          .join("\n")
          .trim();

        const { error: dbError } = await supabase.from("news").insert([
          {
            title,
            content,
            category: feed.category,
            original_url: article.link,
          },
        ]);

        if (dbError) throw dbError;
        console.log(`[Supabase saved success: TITLE: ${title}]`);
        await sleep(7000);
      } catch (error) {
        console.error(`[Unexpected Error : ${error.message}]`);
      }
    }
  }
}

main();
