// 最小占位实现——任务 12 重写为完整折叠思考块，接口保持 { text, live } 不变。
export function ThinkingBlock({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  return (
    <p
      className={`my-1 text-xs italic text-(--color-app-muted) ${live ? "animate-pulse" : ""}`}
    >
      {text}
    </p>
  );
}
