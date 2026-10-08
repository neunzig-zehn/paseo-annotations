import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { Annotation } from "../shared/annotations";
import { sendMessage } from "./actions";
import type { AgentObserver } from "./agents";
import { annotationLabel, excerpt, formatAnnotations } from "./format";
import type { AnnotationStore } from "./store";
import { collapseParent, defaultSendBehavior, editAnnotationInChat } from "./web";
import { BADGE_COLOR } from "./web/theme";

type Theme = PluginButtonContentProps["theme"];

export interface ComposerPills extends AgentObserver {
  dispose(): void;
}

/**
 * The pill renders as label only, like Tasks and Subagents. The plugin API
 * always reserves an icon slot, so this "icon" removes its own slot on the web.
 */
function NoIcon() {
  return <View ref={collapseParent} />;
}

/**
 * One "N annotations" pill per agent in the composer track, shown while that
 * agent has annotations waiting for its next message. It opens a panel built
 * like the Tasks and Subagents panels.
 */
export function createComposerPills(client: PluginClientContext, store: AnnotationStore): ComposerPills {
  const Content = createAnnotationsPanel(store);
  const pills = new Map<string, { registration: PluginButtonRegistration; workspaceId: string; count: number }>();
  let disposed = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const unsubscribe = store.subscribe(() => {
    for (const [agentId, pill] of pills) {
      const count = store.pending(agentId).length;
      if (count === pill.count) continue;
      pill.count = count;
      pill.registration.update({ label: annotationLabel(count), visible: count > 0 });
    }
  });

  return {
    upsert(agent) {
      if (disposed) return;
      const existing = pills.get(agent.id);
      if (existing?.workspaceId === agent.workspaceId) return;
      existing?.registration.remove();
      const count = store.pending(agent.id).length;
      const registration = client.addComposerPill({
        id: "annotations",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Annotations",
          icon: NoIcon,
          label: annotationLabel(count),
          visible: count > 0,
          behavior: { kind: "popover", Content },
        },
      });
      pills.set(agent.id, { registration, workspaceId: agent.workspaceId, count });
    },
    remove,
    dispose() {
      disposed = true;
      unsubscribe();
      for (const agentId of [...pills.keys()]) remove(agentId);
    },
  };
}

function createAnnotationsPanel(store: AnnotationStore): ComponentType<PluginButtonContentProps> {
  const subscribe = (listener: () => void) => store.subscribe(listener);
  const none: readonly Annotation[] = [];

  return function AnnotationsPanel(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const all = useSyncExternalStore(subscribe, () => (agentId ? store.get(agentId) : none));
    const pending = useMemo(() => all.filter((annotation) => annotation.status === "pending"), [all]);
    const paseo = usePaseo();
    const toast = useToast();
    const [sending, setSending] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const { theme, layout, close } = props;
    const styles = useMemo(() => createStyles(theme), [theme]);

    if (!agentId) return null;

    const report = (fallback: string) => (error: unknown) =>
      toast.error(error instanceof Error ? error.message : fallback);

    const sendNow = async () => {
      if (sending || pending.length === 0) return;
      setSending(true);
      try {
        const outcome = await sendMessage(paseo, agentId, formatAnnotations(pending), defaultSendBehavior());
        await store.markSent(agentId, pending.map((annotation) => annotation.id));
        if (outcome === "queued") toast.show("Queued, sends when the current turn ends");
        close();
      } catch (error) {
        report("Could not send the annotations")(error);
      } finally {
        setSending(false);
      }
    };

    const busy = sending || pending.length === 0;
    return (
      <View style={styles.panel}>
        <ScrollView style={styles.list}>
          {pending.map((annotation, index) =>
            editing === annotation.id ? (
              <EditRow
                key={annotation.id}
                annotation={annotation}
                theme={theme}
                onDone={(comment) => {
                  setEditing(null);
                  if (comment !== null) store.setComment(annotation, comment).catch(report("Could not save"));
                }}
              />
            ) : (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                number={index + 1}
                theme={theme}
                actionsAlwaysVisible={Platform.OS !== "web" || layout.compact}
                onPress={() => {
                  // On the web the card opens at the passage; elsewhere, or when the
                  // passage is not on screen, the comment is edited here.
                  if (editAnnotationInChat(annotation)) close();
                  else setEditing(annotation.id);
                }}
                onRemove={() => store.remove(agentId, [annotation.id]).catch(report("Could not delete"))}
              />
            ),
          )}
        </ScrollView>
        <View style={styles.separator} />
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove all annotations"
            disabled={busy}
            onPress={() => {
              store.remove(agentId, pending.map((annotation) => annotation.id)).catch(report("Could not clear"));
              close();
            }}
            style={(state) => [styles.button, state.pressed && styles.pressed, busy && styles.disabled]}
          >
            {(state) => (
              <Text style={isHovered(state) ? styles.ghostTextHovered : styles.ghostText}>Clear all</Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send the annotations now"
            disabled={busy}
            onPress={() => void sendNow()}
            style={(state) => [styles.button, styles.primary, state.pressed && styles.pressed, busy && styles.disabled]}
          >
            <Text style={styles.primaryText}>{sending ? "Sending…" : "Send now"}</Text>
          </Pressable>
        </View>
      </View>
    );
  };
}

const ROW_ICON_SIZE = 14;

/** Paseo's track panel row: a rounded fill inset from the panel edge, 32px tall. */
function PanelRow({
  theme,
  disabled,
  accessibilityLabel,
  onPress,
  children,
}: {
  theme: Theme;
  disabled?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  children: (state: { active: boolean }) => ReactNode;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onPress={onPress}
      >
        {({ pressed }) => {
          const active = !disabled && (hovered || pressed);
          return (
            <View style={[active ? styles.rowActive : styles.row, disabled && styles.disabled]}>
              {children({ active })}
            </View>
          );
        }}
      </Pressable>
    </View>
  );
}

function AnnotationRow({
  annotation,
  number,
  theme,
  actionsAlwaysVisible,
  onPress,
  onRemove,
}: {
  annotation: Annotation;
  number: number;
  theme: Theme;
  actionsAlwaysVisible: boolean;
  onPress: () => void;
  onRemove: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const comment = annotation.comment.trim();
  const passage = excerpt(annotation.anchorText || annotation.quote, 80);
  return (
    <PanelRow theme={theme} accessibilityLabel={`Annotation ${number}: ${comment || passage}`} onPress={onPress}>
      {({ active }) => (
        <>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{number}</Text>
          </View>
          <Text style={comment ? styles.commentLabel : styles.rowLabelMuted} numberOfLines={1}>
            {comment || passage}
          </Text>
          {comment ? (
            <Text style={styles.rowTrailing} numberOfLines={1}>
              {passage}
            </Text>
          ) : null}
          <View
            style={actionsAlwaysVisible || active ? styles.actions : styles.actionsHidden}
            pointerEvents={actionsAlwaysVisible || active ? "auto" : "none"}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete annotation ${number}`}
              onPress={onRemove}
              hitSlop={8}
              style={styles.actionButton}
            >
              {(state) => (
                <Icon
                  name="Trash2"
                  size={ROW_ICON_SIZE}
                  color={isHovered(state) || state.pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </Pressable>
          </View>
        </>
      )}
    </PanelRow>
  );
}

/** Edits a comment in place where the chat's own card is not available. */
function EditRow({
  annotation,
  theme,
  onDone,
}: {
  annotation: Annotation;
  theme: Theme;
  onDone: (comment: string | null) => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [draft, setDraft] = useState(annotation.comment);
  return (
    <View style={styles.editRow}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => onDone(draft.trim())}
        onSubmitEditing={() => onDone(draft.trim())}
        placeholder="Message to the agent about this selection…"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoFocus
        multiline
        accessibilityLabel="Comment"
        style={styles.input}
      />
    </View>
  );
}

/** React Native Web reports hover in the state callback; native platforms do not. */
function isHovered(state: PressableStateCallbackType): boolean {
  return "hovered" in state && state.hovered === true;
}

/** The Tasks and Subagents panel geometry, inside the plugin popover's 12px padding. */
function createStyles(theme: Theme) {
  const { colors } = theme;
  const row = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    minHeight: 32,
    marginHorizontal: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  };
  return {
    // The host pads popover content by 12px; panels sit 4px from the surface.
    panel: { marginHorizontal: -12, marginVertical: -8 },
    list: { flexGrow: 0 },
    row,
    rowActive: { ...row, backgroundColor: colors.surface2 },
    disabled: { opacity: 0.5 },
    separator: { height: 1, marginVertical: 4, backgroundColor: colors.border },
    // Paseo's small buttons: 32px tall, 12px radius, 14px text.
    footer: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    button: {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "transparent",
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    primary: { backgroundColor: colors.accent, borderColor: colors.accent },
    pressed: { opacity: 0.85 },
    primaryText: { fontSize: 14, color: colors.accentForeground },
    ghostText: { fontSize: 14, color: colors.foregroundMuted },
    ghostTextHovered: { fontSize: 14, color: colors.foreground },
    rowLabelMuted: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: "auto" as const,
      minWidth: 0,
      fontSize: 14,
      color: colors.foregroundMuted,
    },
    // A comment keeps its own width up to two thirds of the row; the passage
    // excerpt takes the rest and truncates first.
    commentLabel: { flexShrink: 0, maxWidth: "66%" as const, fontSize: 14, color: colors.foreground },
    rowTrailing: { flexGrow: 1, flexShrink: 1, flexBasis: "auto" as const, minWidth: 0, fontSize: 12, color: colors.foregroundMuted },
    badge: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: BADGE_COLOR,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    badgeText: { fontSize: 11, lineHeight: 18, fontWeight: "600" as const, color: "#ffffff" },
    actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, opacity: 1 },
    actionsHidden: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, opacity: 0 },
    actionButton: { padding: 4, alignItems: "center" as const, justifyContent: "center" as const },
    editRow: { marginHorizontal: 4, paddingHorizontal: 4, paddingVertical: 4 },
    input: {
      minHeight: 64,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
      fontSize: 14,
      color: colors.foreground,
      textAlignVertical: "top" as const,
    },
  };
}
