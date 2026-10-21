"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoaderCircleIcon, UsersIcon } from "lucide-react";

interface ContactItem {
  id: string;
  name: string | null;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  lastEmailedAt?: number | null;
}

interface ContactsDialogProps {
  contacts: ContactItem[];
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function ContactsDialog({
  contacts,
  loading,
  onOpenChange,
  open,
}: ContactsDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersIcon className="size-4" /> Known contacts
          </DialogTitle>
          <DialogDescription>
            People whose email the assistant looked up or saved, stored
            locally. Ask &quot;who do you know at X&quot; in chat anytime.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          {loading ? (
            <LoaderCircleIcon className="text-muted-foreground mx-auto size-5 animate-spin" />
          ) : contacts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No contacts yet — enrich someone via chat and they&apos;ll appear
              here automatically.
            </p>
          ) : (
            contacts.map((contact) => (
              <div
                className="border-border/60 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                key={contact.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {contact.linkedinUrl ? (
                      <a
                        className="hover:underline"
                        href={contact.linkedinUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {contact.name ?? "(no name)"}
                      </a>
                    ) : (
                      (contact.name ?? "(no name)")
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {contact.title ? `${contact.title} @ ` : ""}
                    {contact.company ?? contact.domain ?? ""}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col items-end gap-1">
                  <span className="max-w-full truncate font-mono text-xs">
                    {contact.email ?? "no email yet"}
                  </span>
                  <div className="flex items-center gap-1">
                    {contact.lastEmailedAt ? (
                      <Badge className="rounded-full text-[10px]" variant="secondary">
                        emailed {new Date(contact.lastEmailedAt).toLocaleDateString()}
                      </Badge>
                    ) : null}
                    {contact.emailStatus ? (
                      <Badge
                        className="rounded-full text-[10px]"
                        variant={
                          ["verified", "valid"].includes(contact.emailStatus.toLowerCase())
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {contact.emailStatus}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}