import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const allowedElements = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "sup", "a", "img",
];

const components: Components = {
  // Model-generated destinations must never become navigable or load resources.
  a: ({ children }) => <span>{children}（链接已禁用）</span>,
  img: ({ alt }) => <span>［图片已禁用{alt ? `：${alt}` : ""}］</span>,
};

export default function SafeAnalysisMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={allowedElements}
      components={components}
      skipHtml
      urlTransform={() => undefined}
    >
      {children}
    </ReactMarkdown>
  );
}
