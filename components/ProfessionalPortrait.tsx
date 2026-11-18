import Image from "next/image";

type ProfessionalPortraitProps = {
  src?: string;
  priority?: boolean;
};

export const preferredPortraitPath = "/jcquevedo84-linkedin.jpg";

export function ProfessionalPortrait({
  src = preferredPortraitPath,
  priority = false,
}: ProfessionalPortraitProps) {
  return (
    <figure className="professional-portrait">
      <Image
        src={src}
        alt="Professional portrait of Juan Carlos Rodríguez Quevedo wearing a navy-blue collared shirt in a warm office setting"
        width={900}
        height={900}
        sizes="(max-width: 560px) 72vw, (max-width: 820px) 300px, 280px"
        priority={priority}
        unoptimized
      />
      <figcaption>Juan Carlos Rodríguez Quevedo · Buenos Aires, Argentina</figcaption>
    </figure>
  );
}
