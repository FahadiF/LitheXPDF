//! Native Windows printing. The printer dialog and all PDFium page work run
//! on the worker's owner thread; the Tauri host only awaits the bounded IPC
//! result and never renders PDF content.

use crate::{
    bounded_render_dimensions, validate_bitmap_size, MAX_BITMAP_DIMENSION, MAX_RGBA_BITMAP_BYTES,
};
use pdfium_render::prelude::PdfDocument;
use std::{mem::size_of, ptr};
use windows::Win32::{
    Foundation::{GlobalFree, HGLOBAL, HWND},
    Graphics::Gdi::{
        DeleteDC, GetDeviceCaps, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, GDI_ERROR, HORZRES, LOGPIXELSX, LOGPIXELSY, SRCCOPY, VERTRES,
    },
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    UI::Controls::Dialogs::{
        PrintDlgExW, PD_DISABLEPRINTTOFILE, PD_NOCURRENTPAGE, PD_NOPAGENUMS, PD_NOSELECTION,
        PD_RESULT_CANCEL, PD_RESULT_PRINT, PD_RETURNDC, PD_USEDEVMODECOPIESANDCOLLATE, PRINTDLGEXW,
        START_PAGE_GENERAL,
    },
};

const MAX_PRINT_JOB_PAGES: u64 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub struct PrintOutcome {
    pub cancelled: bool,
    pub pages_printed: u32,
}

#[repr(C)]
struct DocInfoW {
    cb_size: i32,
    document_name: *const u16,
    output: *const u16,
    data_type: *const u16,
    flags: u32,
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn StartDocW(hdc: windows::Win32::Graphics::Gdi::HDC, info: *const DocInfoW) -> i32;
    fn StartPage(hdc: windows::Win32::Graphics::Gdi::HDC) -> i32;
    fn EndPage(hdc: windows::Win32::Graphics::Gdi::HDC) -> i32;
    fn EndDoc(hdc: windows::Win32::Graphics::Gdi::HDC) -> i32;
    fn AbortDoc(hdc: windows::Win32::Graphics::Gdi::HDC) -> i32;
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result.is_err() {
            return Err(format!(
                "Could not initialize the Windows print dialog: {result:?}"
            ));
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct OwnedPrinterDc(windows::Win32::Graphics::Gdi::HDC);

impl Drop for OwnedPrinterDc {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            let _ = unsafe { DeleteDC(self.0) };
        }
    }
}

struct OwnedGlobal(HGLOBAL);

impl Drop for OwnedGlobal {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            let _ = unsafe { GlobalFree(Some(self.0)) };
        }
    }
}

/// Displays the Windows print property sheet, then renders the selected pages
/// directly to the returned printer DC one page at a time. The temporary
/// PDFium bitmap is bounded by the worker's normal 32 MiB RGBA limit.
pub fn print_document(
    document: &PdfDocument<'_>,
    owner_window: usize,
    current_page: u32,
    page_selection: u8,
    range_start: u32,
    range_end: u32,
) -> Result<PrintOutcome, String> {
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| "PDF page count exceeds the Windows print dialog limit")?;
    if page_count == 0 || current_page >= page_count {
        return Err("The selected print page is outside the document".into());
    }
    if owner_window == 0 || owner_window > isize::MAX as usize {
        return Err("The LitheXPDF window handle is invalid".into());
    }

    let _com = ComApartment::initialize()?;
    let selected_ranges = selected_ranges(
        page_selection,
        range_start,
        range_end,
        page_count,
        current_page,
    )?;
    let mut dialog = PRINTDLGEXW::default();
    dialog.lStructSize = size_of::<PRINTDLGEXW>() as u32;
    dialog.hwndOwner = HWND(owner_window as *mut _);
    dialog.Flags = PD_RETURNDC
        | PD_NOPAGENUMS
        | PD_NOCURRENTPAGE
        | PD_DISABLEPRINTTOFILE
        | PD_NOSELECTION
        | PD_USEDEVMODECOPIESANDCOLLATE;
    dialog.nMinPage = 1;
    dialog.nMaxPage = page_count;
    dialog.nCopies = 1;
    dialog.nStartPage = START_PAGE_GENERAL;

    let dialog_result = unsafe { PrintDlgExW(&mut dialog) };
    let _dev_mode = OwnedGlobal(dialog.hDevMode);
    let _dev_names = OwnedGlobal(dialog.hDevNames);
    let printer_dc = OwnedPrinterDc(dialog.hDC);
    dialog_result.map_err(|error| format!("Could not open the Windows print dialog: {error}"))?;

    if dialog.dwResultAction == PD_RESULT_CANCEL {
        return Ok(PrintOutcome {
            cancelled: true,
            pages_printed: 0,
        });
    }
    if dialog.dwResultAction != PD_RESULT_PRINT {
        return Err("The Windows print dialog returned an unsupported action".into());
    }
    if printer_dc.0 .0.is_null() {
        return Err("The Windows print dialog did not provide a printer device context".into());
    }

    let selected_page_count = selected_ranges
        .iter()
        .try_fold(0u64, |total, (from, to)| {
            total.checked_add(u64::from(to - from) + 1)
        })
        .ok_or("Selected print range overflow")?;
    if selected_page_count > MAX_PRINT_JOB_PAGES {
        return Err(format!(
            "Printing is limited to {MAX_PRINT_JOB_PAGES} pages per job. Choose a smaller page range."
        ));
    }

    let title: Vec<u16> = "LitheXPDF document".encode_utf16().chain(Some(0)).collect();
    let info = DocInfoW {
        cb_size: size_of::<DocInfoW>() as i32,
        document_name: title.as_ptr(),
        output: ptr::null(),
        data_type: ptr::null(),
        flags: 0,
    };
    let started = unsafe { StartDocW(printer_dc.0, &info) };
    if started <= 0 {
        return Err("The selected printer could not start the print job".into());
    }

    let mut pages_printed = 0u32;
    for (from_page, to_page) in selected_ranges {
        for page_number in from_page..=to_page {
            if unsafe { StartPage(printer_dc.0) } <= 0 {
                unsafe { AbortDoc(printer_dc.0) };
                return Err(format!("The printer could not start page {page_number}"));
            }
            if let Err(error) = render_page_to_printer(document, printer_dc.0, page_number - 1) {
                unsafe { AbortDoc(printer_dc.0) };
                return Err(error);
            }
            if unsafe { EndPage(printer_dc.0) } <= 0 {
                unsafe { AbortDoc(printer_dc.0) };
                return Err(format!("The printer could not finish page {page_number}"));
            }
            pages_printed = pages_printed
                .checked_add(1)
                .ok_or("Printed page count overflow")?;
        }
    }

    if unsafe { EndDoc(printer_dc.0) } <= 0 {
        unsafe { AbortDoc(printer_dc.0) };
        return Err("The printer could not complete the print job".into());
    }

    Ok(PrintOutcome {
        cancelled: false,
        pages_printed,
    })
}

fn selected_ranges(
    page_selection: u8,
    range_start: u32,
    range_end: u32,
    page_count: u32,
    current_page: u32,
) -> Result<Vec<(u32, u32)>, String> {
    let range = match page_selection {
        0 if range_start == 0 && range_end == 0 => (current_page + 1, current_page + 1),
        1 if range_start == 0 && range_end == 0 => (1, page_count),
        2 if range_start > 0 && range_start <= range_end && range_end <= page_count => {
            (range_start, range_end)
        }
        0..=2 => return Err("Invalid page selection passed to the printer".into()),
        _ => return Err("Unknown page selection passed to the printer".into()),
    };
    let selected_page_count = u64::from(range.1 - range.0) + 1;
    if selected_page_count > MAX_PRINT_JOB_PAGES {
        return Err(format!(
            "Printing is limited to {MAX_PRINT_JOB_PAGES} pages per job. Choose a smaller page range."
        ));
    }
    Ok(vec![range])
}

fn render_page_to_printer(
    document: &PdfDocument<'_>,
    hdc: windows::Win32::Graphics::Gdi::HDC,
    page_index: u32,
) -> Result<(), String> {
    use pdfium_render::prelude::{PdfBitmapFormat, PdfRenderConfig};

    let page = document.pages().get(page_index as i32).map_err(|error| {
        format!(
            "Could not load PDF page {} for printing: {error}",
            page_index + 1
        )
    })?;
    let page_width = page.width().value;
    let page_height = page.height().value;
    let printable_width = unsafe { GetDeviceCaps(Some(hdc), HORZRES) };
    let printable_height = unsafe { GetDeviceCaps(Some(hdc), VERTRES) };
    let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
    if printable_width <= 0 || printable_height <= 0 || dpi_x <= 0 || dpi_y <= 0 {
        return Err("The selected printer reported invalid printable dimensions".into());
    }

    let desired_width =
        (f64::from(page_width) / 72.0 * f64::from(dpi_x)).min(f64::from(printable_width));
    let desired_height =
        (f64::from(page_height) / 72.0 * f64::from(dpi_y)).min(f64::from(printable_height));
    let fit = (f64::from(printable_width) / desired_width)
        .min(f64::from(printable_height) / desired_height)
        .min(1.0);
    let target_width = (desired_width * fit).floor().max(1.0) as u32;
    let target_height = (desired_height * fit).floor().max(1.0) as u32;
    let (target_width, target_height) =
        bounded_render_dimensions(page_width, page_height, target_width, target_height, 1.0)?;

    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_size(target_width as i32, target_height as i32)
                .set_maximum_width(MAX_BITMAP_DIMENSION as i32)
                .set_maximum_height(MAX_BITMAP_DIMENSION as i32),
        )
        .map_err(|error| {
            format!(
                "Could not render PDF page {} for printing: {error}",
                page_index + 1
            )
        })?;
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    validate_bitmap_size(width, height)?;
    if !matches!(
        bitmap.format(),
        Ok(PdfBitmapFormat::BGRA | PdfBitmapFormat::BGRx)
    ) {
        return Err("PDFium returned an unsupported bitmap format for Windows printing".into());
    }
    let pixels = bitmap.as_raw_bytes();
    let expected_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(4))
        .and_then(|stride| stride.checked_mul(height as usize))
        .ok_or("Printer bitmap byte count overflow")?;
    if pixels.len() != expected_bytes || expected_bytes > MAX_RGBA_BITMAP_BYTES {
        return Err("PDFium returned printer bitmap data outside the memory limit".into());
    }

    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width as i32,
        biHeight: -(height as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: expected_bytes as u32,
        ..Default::default()
    };

    let x = (printable_width - width as i32) / 2;
    let y = (printable_height - height as i32) / 2;
    let result = unsafe {
        StretchDIBits(
            hdc,
            x,
            y,
            width as i32,
            height as i32,
            0,
            0,
            width as i32,
            height as i32,
            Some(pixels.as_ptr().cast()),
            &info,
            DIB_RGB_COLORS,
            SRCCOPY,
        )
    };
    if result == GDI_ERROR || result == 0 {
        return Err(format!(
            "Could not transfer PDF page {} to the printer",
            page_index + 1
        ));
    }
    Ok(())
}
