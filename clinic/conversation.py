"""
Clinic Dialogue Manager
Manages conversation state, handles patient intents, and generates natural voice responses.
"""

from typing import Dict, Any, List, Optional
from .knowledge_base import CLINIC_DATA, get_doctor_info, get_clinic_hours

class ClinicDialogueManager:
    def __init__(self):
        self.state = "GREETING"
        self.booking_data = {
            "patient_name": None,
            "doctor": None,
            "slot": None,
            "phone": None,
        }

    def reset(self):
        self.state = "GREETING"
        self.booking_data = {
            "patient_name": None,
            "doctor": None,
            "slot": None,
            "phone": None,
        }

    def process_message(self, user_text: str) -> str:
        """
        Process user speech transcript and return agent voice response.
        Adds Timbre audio tags like <pauses> for natural speech rhythm.
        """
        text = user_text.strip().lower()

        # Check for emergency keywords
        if any(w in text for w in ["emergency", "आपातकालीन", "heart attack", "bleeding", "accidental", "severe pain"]):
            return (
                "अगर यह कोई मेडिकल इमरजेंसी है, <pauses> तो कृपया तुरंत नजदीकी अस्पताल के इमरजेंसी वार्ड में जाएं "
                "या तुरंत 108 डायल करें। हमारी क्लिनिक ओपीडी सेवाओं के लिए खुली है।"
            )

        # Check for timings / hours
        if any(w in text for w in ["timing", "timings", "time", "hours", "open", "समय", "खुलती", "कब"]):
            return (
                f"आरोग्य केयर क्लिनिक सोमवार से शनिवार सुबह 9 बजे से दोपहर 1 बजे, <pauses> "
                f"और शाम 5 बजे से रात 9 बजे तक खुली रहती है। क्या आप किसी डॉक्टर से अपॉइंटमेंट बुक करना चाहते हैं?"
            )

        # Check for address / location
        if any(w in text for w in ["address", "location", "कहाँ", "पता", "where", "landmark"]):
            return (
                f"हमारी क्लिनिक का पता है: {CLINIC_DATA['address']}। <pauses> "
                "क्या आपको क्लिनिक पहुंचने या अपॉइंटमेंट लेने में कोई सहायता चाहिए?"
            )

        # Check for doctors list
        if any(w in text for w in ["doctor", "doctors", "डॉक्टर", "specialist", "physician", "pediatrician"]):
            docs_summary = ", ".join([f"{d['name']} ({d['specialty']})" for d in CLINIC_DATA["doctors"]])
            return (
                f"हमारे पास उपलब्ध विशेषज्ञ डॉक्टर हैं: <pauses> {docs_summary}। "
                "आप किस डॉक्टर के लिए अपॉइंटमेंट बुक करना चाहेंगे?"
            )

        # Check for booking intent
        if any(w in text for w in ["book", "appointment", "अपॉइंटमेंट", "मिलना है", "consultation", "दिखाना"]):
            self.state = "COLLECTING_DOCTOR"
            return (
                "ज़रूर! मैं आपकी अपॉइंटमेंट बुक करने में मदद कर सकती हूँ। <pauses> "
                "कृपया बताएं कि आप किस डॉक्टर से मिलना चाहते हैं, या आपको क्या समस्या महसूस हो रही है?"
            )

        # Default fallback
        return (
            "नमस्ते! आरोग्य केयर क्लिनिक में आपका स्वागत है। <pauses> "
            "मैं आपकी डॉक्टर अपॉइंटमेंट बुक करने, क्लिनिक के समय और उपलब्ध सुविधाओं की जानकारी देने में मदद कर सकती हूँ। "
            "बताइए मैं आपकी क्या सहायता करूँ?"
        )
