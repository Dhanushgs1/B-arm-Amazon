// Platform brand marks for the marketplace navigation. The marks are the brands' trademarks, shown
// here only to label each platform.
//   - Amazon and Shopify: official marks as published by simple-icons v14.15.0 (path data CC0-1.0,
//     verified byte-for-byte against that release).
//   - Flipkart: the full-colour bag mark from Flipkart's own 2026 logo (Wikimedia Commons
//     "File:Flipkart logo (2026).svg", sourced from Flipkart's website, md5 8a967afae83d6f8afcc1e72f9b15572b).
//     Only the SVG's viewBox was narrowed to the bag, then rendered to public/brand/flipkart.png (256px);
//     the artwork is not redrawn. (simple-icons' single-colour Flipkart glyph reads as Facebook's "f".)
//   - Meesho: the "m" mark from Meesho's own published app logo https://meesho.io/img/meesho-logo.png
//     (1080x1080, md5 fe6e8a15efc9d3e6481b755114ca667a). Cropped to the "m" (the small "meesho"
//     wordmark under it is unreadable at nav size), squared on the logo's own purple, 256px:
//     public/brand/meesho.png. Not redrawn.

export type BrandId = "amazon" | "flipkart" | "meesho" | "shopify";

const MARKS: Record<"amazon" | "shopify", { title: string; color: string; path: string }> = {
  amazon: { title: "Amazon", color: "#FF9900", path: "M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.14c.138-.06.234-.1.293-.13.226-.088.39-.046.525.13.12.174.09.336-.12.48-.256.19-.6.41-1.006.654-1.244.743-2.64 1.316-4.185 1.726a17.617 17.617 0 01-10.951-.577 17.88 17.88 0 01-5.43-3.35c-.1-.074-.151-.15-.151-.22 0-.047.021-.09.051-.13zm6.565-6.218c0-1.005.247-1.863.743-2.577.495-.71 1.17-1.25 2.04-1.615.796-.335 1.756-.575 2.912-.72.39-.046 1.033-.103 1.92-.174v-.37c0-.93-.105-1.558-.3-1.875-.302-.43-.78-.65-1.44-.65h-.182c-.48.046-.896.196-1.246.46-.35.27-.575.63-.675 1.096-.06.3-.206.465-.435.51l-2.52-.315c-.248-.06-.372-.18-.372-.39 0-.046.007-.09.022-.15.247-1.29.855-2.25 1.82-2.88.976-.616 2.1-.975 3.39-1.05h.54c1.65 0 2.957.434 3.888 1.29.135.15.27.3.405.48.12.165.224.314.283.45.075.134.15.33.195.57.06.254.105.42.135.51.03.104.062.3.076.615.01.313.02.493.02.553v5.28c0 .376.06.72.165 1.036.105.313.21.54.315.674l.51.674c.09.136.136.256.136.36 0 .12-.06.226-.18.314-1.2 1.05-1.86 1.62-1.963 1.71-.165.135-.375.15-.63.045a6.062 6.062 0 01-.526-.496l-.31-.347a9.391 9.391 0 01-.317-.42l-.3-.435c-.81.886-1.603 1.44-2.4 1.665-.494.15-1.093.227-1.83.227-1.11 0-2.04-.343-2.76-1.034-.72-.69-1.08-1.665-1.08-2.94l-.05-.076zm3.753-.438c0 .566.14 1.02.425 1.364.285.34.675.512 1.155.512.045 0 .106-.007.195-.02.09-.016.134-.023.166-.023.614-.16 1.08-.553 1.424-1.178.165-.28.285-.58.36-.91.09-.32.12-.59.135-.8.015-.195.015-.54.015-1.005v-.54c-.84 0-1.484.06-1.92.18-1.275.36-1.92 1.17-1.92 2.43l-.035-.02zm9.162 7.027c.03-.06.075-.11.132-.17.362-.243.714-.41 1.05-.5a8.094 8.094 0 011.612-.24c.14-.012.28 0 .41.03.65.06 1.05.168 1.172.33.063.09.099.228.099.39v.15c0 .51-.149 1.11-.424 1.8-.278.69-.664 1.248-1.156 1.68-.073.06-.14.09-.197.09-.03 0-.06 0-.09-.012-.09-.044-.107-.12-.064-.24.54-1.26.806-2.143.806-2.64 0-.15-.03-.27-.087-.344-.145-.166-.55-.257-1.224-.257-.243 0-.533.016-.87.046-.363.045-.7.09-1 .135-.09 0-.148-.014-.18-.044-.03-.03-.036-.047-.02-.077 0-.017.006-.03.02-.063v-.06z" },
  shopify: { title: "Shopify", color: "#7AB55C", path: "M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z" },
};

// full-colour logo files; each carries its own background, so it reads on light and dark
const IMAGES: Record<"flipkart" | "meesho", { src: string; rounded: string }> = {
  flipkart: { src: "/brand/flipkart.png", rounded: "" },
  meesho: { src: "/brand/meesho.png", rounded: "rounded-[3px]" },
};

export const MEESHO_COLOR = "#9F2089";

/** A platform mark sized `size` px, in the brand's own colours. Decorative by default (the tab
 *  label next to it names the platform); pass `title` when it stands alone. */
export function BrandLogo({ brand, size = 16, title, className }: { brand: BrandId; size?: number; title?: string; className?: string }) {
  if (brand === "flipkart" || brand === "meesho") {
    const img = IMAGES[brand];
    return (
      <img
        src={img.src}
        width={size}
        height={size}
        alt={title ?? ""}
        className={["object-contain", img.rounded, className].filter(Boolean).join(" ")}
        draggable={false}
        {...(title ? {} : { "aria-hidden": true })}
      />
    );
  }
  const a11y = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  const m = MARKS[brand];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...a11y}>
      <path d={m.path} fill={m.color} />
    </svg>
  );
}
