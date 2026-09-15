"use client";

/**
 * Print and back, kept out of the printed document itself.
 *
 * "Download PDF" opens the browser's print dialog, where Save as PDF produces
 * the file. That is the honest label for what happens, and it is why the button
 * says Download rather than Print — the customer wants a PDF, and this is the
 * route to one until a server-side renderer exists.
 */
export default function InvoiceActions({ number }: { number: string }) {
  return (
    <div className="invoice-actions no-print">
      <button className="btn" onClick={() => history.back()}>
        &larr; Back
      </button>
      <button
        className="btn btn-primary"
        onClick={() => {
          document.title = `Invoice ${number}`;
          window.print();
        }}
      >
        Download PDF
      </button>
    </div>
  );
}
