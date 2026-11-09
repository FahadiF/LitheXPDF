use pdfium_render::prelude::{
    PdfColor, PdfPageAnnotationCommon, PdfPageAnnotationType, PdfPageContentRegenerationStrategy,
    PdfPageObjectsCommon, PdfPoints, PdfQuadPoints, Pdfium,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

fn pdfium_dll() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("resources")
        .join("pdfium")
        .join("pdfium.dll")
        .canonicalize()
        .expect("selected PDFium DLL must exist for the annotation compatibility test")
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("smoke-one-page.pdf")
}

fn temp_pdf() -> PathBuf {
    let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "lithexpdf-annotations-{}-{id}.pdf",
        std::process::id()
    ))
}

struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn selected_pdfium_creates_saves_and_reloads_highlight_note_and_ink_annotations() {
    let dll = pdfium_dll();
    assert!(dll.is_absolute());
    let output_path = temp_pdf();
    let _cleanup = RemoveOnDrop(output_path.clone());
    let source = fixture();
    let source_before = std::fs::read(&source).expect("annotation fixture should be readable");
    let bindings = Pdfium::bind_to_library(&dll)
        .expect("selected PDFium library should load for annotation compatibility test");
    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_file(&source, None)
        .expect("annotation fixture should open");

    {
        let mut page = document.pages().get(0).expect("fixture page should open");
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
        let annotations = page.annotations_mut();

        let mut highlight = annotations
            .create_highlight_annotation()
            .expect("PDFium should create a highlight annotation");
        highlight
            .set_bounds(pdfium_render::prelude::PdfRect::new_from_values(
                80.0, 20.0, 120.0, 120.0,
            ))
            .expect("highlight bounds should be set");
        highlight
            .set_fill_color(PdfColor::new(255, 230, 0, 128))
            .expect("highlight color should be set");
        highlight
            .attachment_points_mut()
            .create_attachment_point_at_end(PdfQuadPoints::new_from_values(
                20.0, 120.0, 120.0, 120.0, 20.0, 80.0, 120.0, 80.0,
            ))
            .expect("highlight geometry should be attached");

        let mut note = annotations
            .create_free_text_annotation("LitheXPDF annotation smoke test")
            .expect("PDFium should create a text annotation");
        note.set_bounds(pdfium_render::prelude::PdfRect::new_from_values(
            25.0, 20.0, 60.0, 150.0,
        ))
        .expect("note bounds should be set");

        let mut ink = annotations
            .create_ink_annotation()
            .expect("PDFium should create a freehand annotation");
        ink.objects_mut()
            .create_path_object_line(
                PdfPoints::new(25.0),
                PdfPoints::new(45.0),
                PdfPoints::new(100.0),
                PdfPoints::new(45.0),
                PdfColor::new(220, 20, 60, 255),
                PdfPoints::new(2.0),
            )
            .expect("ink path should be attached");
        page.regenerate_content()
            .expect("annotated page content should regenerate");
    }

    document
        .save_to_file(&output_path)
        .expect("PDFium should serialize the annotated copy");
    drop(document);
    assert_eq!(
        std::fs::read(&source).expect("source PDF should remain readable"),
        source_before,
        "annotation export must not alter the source PDF"
    );

    let reopened = pdfium
        .load_pdf_from_file(&output_path, None)
        .expect("annotated PDF should reopen");
    let page = reopened
        .pages()
        .get(0)
        .expect("annotated page should reopen");
    let mut found = Vec::new();
    for annotation in page.annotations().iter() {
        found.push(annotation.annotation_type());
    }
    assert!(
        found.contains(&PdfPageAnnotationType::Highlight),
        "types: {found:?}"
    );
    assert!(
        found.contains(&PdfPageAnnotationType::FreeText),
        "types: {found:?}"
    );
    assert!(
        found.contains(&PdfPageAnnotationType::Ink),
        "types: {found:?}"
    );
}
