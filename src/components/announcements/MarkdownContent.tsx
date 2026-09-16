import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  children: string;
  className?: string;
}

export function MarkdownContent({ children, className }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-foreground",
        "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-2",
        "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-2",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1",
        "[&_p]:mb-2 last:[&_p]:mb-0",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2",
        "[&_li]:mb-1",
        "[&_a]:text-primary [&_a]:underline hover:[&_a]:opacity-80",
        "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
        "[&_pre]:bg-muted [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:mb-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
        "[&_table]:border-collapse [&_table]:my-2",
        "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        "[&_hr]:my-3 [&_hr]:border-border",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            const isExternal = href?.startsWith("http://") || href?.startsWith("https://") || href?.startsWith("//");
            return isExternal
              ? <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
              : <a {...props} href={href} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
