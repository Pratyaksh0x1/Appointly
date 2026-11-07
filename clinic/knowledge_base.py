"""
Clinic Knowledge Base
Holds clinic details, doctors schedule, services, consultation fees, and emergency instructions.
"""

CLINIC_DATA = {
    "clinic_name": "Arogya Care Clinic",
    "address": "42, Green Glen Layout, Bellandur, Bengaluru",
    "contact_phone": "+91 98765 43210",
    "hours": {
        "weekdays": "Monday to Saturday: 9:00 AM - 1:00 PM and 5:00 PM - 9:00 PM",
        "sunday": "Sunday: 10:00 AM - 1:00 PM (Emergency & Prior Appointments only)",
    },
    "doctors": [
        {
            "id": "dr_sharma",
            "name": "Dr. Ramesh Sharma",
            "specialty": "General Physician / Internal Medicine",
            "experience": "15 years",
            "fee": 500,
            "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            "slots": ["09:30 AM", "10:30 AM", "11:30 AM", "05:30 PM", "06:30 PM", "07:30 PM"],
        },
        {
            "id": "dr_priya",
            "name": "Dr. Priya Patel",
            "specialty": "Pediatrician (Child Specialist)",
            "experience": "10 years",
            "fee": 600,
            "days": ["Monday", "Wednesday", "Friday", "Saturday"],
            "slots": ["10:00 AM", "11:00 AM", "12:00 PM", "05:00 PM", "06:00 PM"],
        },
        {
            "id": "dr_rajesh",
            "name": "Dr. Rajesh Kumar",
            "specialty": "Cardiologist (Heart Specialist)",
            "experience": "18 years",
            "fee": 900,
            "days": ["Tuesday", "Thursday", "Saturday"],
            "slots": ["05:00 PM", "06:00 PM", "07:00 PM", "08:00 PM"],
        },
        {
            "id": "dr_ananya",
            "name": "Dr. Ananya Iyer",
            "specialty": "Dermatologist (Skin & Hair)",
            "experience": "8 years",
            "fee": 700,
            "days": ["Monday", "Tuesday", "Thursday", "Friday"],
            "slots": ["10:00 AM", "11:30 AM", "05:30 PM", "07:00 PM"],
        },
    ],
    "services": [
        "General Outpatient Consultation",
        "Pediatric Care & Vaccinations",
        "ECG & Cardiac Screening",
        "Skin & Allergy Treatment",
        "Routine Blood Tests & Diagnostics Lab Collection",
        "Pharmacy & Prescription Refills"
    ],
    "emergency_advice": "यदि यह कोई आपातकालीन स्थिति (Emergency) है जैसे कि गंभीर सीने में दर्द या सांस लेने में बहुत कठिनाई, तो कृपया तुरंत नजदीकी अस्पताल के इमरजेंसी वार्ड में जाएं या 108 पर कॉल करें।"
}

def get_doctor_info(query: str):
    """Find a doctor by name or specialty keywords."""
    query = query.lower()
    for doc in CLINIC_DATA["doctors"]:
        if query in doc["name"].lower() or query in doc["specialty"].lower():
            return doc
    return None

def get_clinic_hours() -> str:
    return f"{CLINIC_DATA['hours']['weekdays']}. {CLINIC_DATA['hours']['sunday']}."
