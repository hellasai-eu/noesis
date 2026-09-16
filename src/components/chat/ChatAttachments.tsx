import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ChatAttachment {
  /** Stable per session — the storage path where there is one, else the URL. */
  id: string;
  name: string;
  /** A URL the browser can render directly; signed URLs expire, so resolve late. */
  url: string;
}

interface ChatAttachmentsProps {
  attachments: ChatAttachment[];
  className?: string;
}

/**
 * The instructor's reference images, shown to the student as attachments.
 *
 * They are not part of the conversation and the tutor is not told about them
 * (see `study-tutor.ts`): the instructor attaches an image to the session and
 * the student can open it whenever they want, rather than the model deciding
 * when it appears. That is why there is no per-image description here — there
 * is nothing left for one to instruct.
 */
export function ChatAttachments({ attachments, className }: ChatAttachmentsProps) {
  const { t } = useTranslation("study");
  const [opened, setOpened] = useState<ChatAttachment | null>(null);

  if (attachments.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
        <Paperclip className="w-3.5 h-3.5" />
        <span>{t("session.attachments", "Attachments")}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {attachments.map((att) => (
          <button
            key={att.id}
            type="button"
            onClick={() => setOpened(att)}
            title={att.name}
            className="group flex items-center gap-2 max-w-[16rem] rounded-lg border bg-background p-1.5 pr-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
          >
            <img
              src={att.url}
              alt=""
              aria-hidden="true"
              className="w-10 h-10 rounded object-cover flex-shrink-0"
            />
            <span className="text-xs truncate">{att.name}</span>
          </button>
        ))}
      </div>

      <Dialog open={!!opened} onOpenChange={(open) => !open && setOpened(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-base pr-8 break-words">{opened?.name}</DialogTitle>
          </DialogHeader>
          {opened && (
            <div className="space-y-3">
              <img
                src={opened.url}
                alt={opened.name}
                className="w-full max-h-[70vh] object-contain rounded"
              />
              <a
                href={opened.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t("session.attachmentOpen", "Open in a new tab")}
              </a>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
