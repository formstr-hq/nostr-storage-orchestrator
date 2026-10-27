import ReactMarkdown from "react-markdown";
import { Navigate, useParams } from "react-router-dom";
import { LEGAL_DOCS } from "../legal";

export function LegalPage() {
  const { doc } = useParams<{ doc: string }>();
  const legal = doc ? LEGAL_DOCS[doc] : undefined;
  if (!legal) return <Navigate to="/" replace />;

  return (
    <div className="card legal">
      <div className="eyebrow">{legal.version}</div>
      <ReactMarkdown skipHtml>{legal.content}</ReactMarkdown>
    </div>
  );
}
