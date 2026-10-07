type SectionHeadingProps = {
  id: string;
  title: string;
  intro: string;
  align?: "left" | "center";
};

export function SectionHeading({ id, title, intro, align = "left" }: SectionHeadingProps) {
  const alignment = align === "center" ? "mx-auto text-center items-center" : "";
  return (
    <div className={`flex max-w-[44rem] flex-col gap-5 ${alignment}`}>
      <h2
        id={id}
        className="text-balance text-[clamp(2rem,4.4vw,3.5rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-fg"
      >
        {title}
      </h2>
      <p className="max-w-[62ch] text-pretty text-[17px] leading-[1.6] text-dim">{intro}</p>
    </div>
  );
}
